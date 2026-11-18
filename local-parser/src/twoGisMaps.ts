import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import type { LocalCollectRequest, LocalJobSnapshot, LocalJobStatus, LocalResultPage } from './contracts.ts'
import { readTwoGisContacts, type WebsiteCheck } from './twoGisWebsite.ts'
import { currentWebsiteCheckVersion } from '../../src/imports/websiteEvidence.ts'
import type { SourceCompanyCard } from '../../src/imports/source.ts'

const maxWaitMs = 8_000
const maxEmptyResultRetries = 5
const captchaText = /captcha|капч|подтвердите.{0,30}(человек|робот)|провер(ка|ьте).{0,30}(человек|робот|запрос)|проверка безопасности|verify.{0,20}(human|person)|security check/i
const accessRestrictionText = /доступ огранич|слишком много запрос|access denied|too many requests|unusual traffic/i
const explicitEmptyText = /ничего не найдено|по запросу ничего не найдено|результатов не найдено/i

interface ProtectionDetection {
  reason: 'captcha_manual' | 'access_restricted'
  message: string
}

interface ExtractedCard {
  sourceCardId: string
  sourceUrl: string
  companyName: string
  address: string | null
  phone: string | null
  website: string | null
  websiteCheckStatus?: WebsiteCheck['websiteCheckStatus']
  websiteCheckVersion?: number
  websiteCheckedAt?: string
  websiteCheckedSourceUrl?: string
  rating: number | null
  reviewCount: number | null
}

interface PendingPage extends LocalResultPage {}

/** Visible-browser adapter for the 2GIS directory. It reads rendered result cards only. */
export class TwoGisLocalJob {
  readonly jobId = randomUUID()
  readonly runId: string
  readonly request: Required<LocalCollectRequest>
  status: LocalJobStatus = 'starting'
  pageIndex = 0
  rawFound = 0
  message: string | null = null
  stopReason: string | null = null
  canContinue = false
  private browser: Browser | null = null
  private page: Page | null = null
  private detailPage: Page | null = null
  private pending: PendingPage | null = null
  private seen: Set<string>
  private retryPageUrl: string | null = null
  private stopAfterThisPage = false
  private emptyResultRetries = 0

  constructor(request: LocalCollectRequest, private readonly onCard?: (card: SourceCompanyCard) => void) {
    this.runId = request.runId
    this.seen = new Set(request.knownCardIds ?? [])
    this.request = {
      ...request,
      city: request.city.trim(),
      niche: request.niche.trim(),
      maxPages: request.maxPages ?? 20,
      maxCandidates: request.maxCandidates ?? 1000,
      knownCardIds: request.knownCardIds ?? [],
      startPage: request.startPage ?? 1,
    }
  }

  async start(): Promise<LocalJobSnapshot> {
    this.status = 'starting'
    try {
      this.browser = await chromium.launch({ headless: false })
      const context = await this.browser.newContext({ locale: 'ru-RU' })
      this.page = await context.newPage()
      this.page.setDefaultTimeout(5_000)
      const searchUrl = buildTwoGisSearchUrl(this.request.niche, this.request.city)
      await this.page.goto(this.request.startPage > 1 ? `${searchUrl}/page/${this.request.startPage}` : searchUrl,
        { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await this.page.waitForTimeout(3_000)
      const blocked = await this.detectProtection()
      if (blocked) return this.stopForAttention(blocked.message, blocked.reason)
      let initial = await this.extractVisibleCards()
      if (!initial.length) {
        const deadline = Date.now() + maxWaitMs
        while (Date.now() < deadline && !initial.length) {
          await this.page.waitForTimeout(500)
          const protection = await this.detectProtection()
          if (protection) return this.stopForAttention(protection.message, protection.reason)
          initial = await this.extractVisibleCards()
        }
      }
      if (!initial.length) {
        const body = await this.page.locator('body').innerText({ timeout: 3_000 }).catch(() => '')
        if (explicitEmptyText.test(body)) {
          this.status = 'partially_completed'
          this.message = '2ГИС не показал подходящих карточек по этому запросу.'
          this.stopReason = 'no_results'
          await this.closeBrowser()
          return this.snapshot()
        }
        return this.stopForAttention('Не удалось распознать карточки 2ГИС. Проверьте открытый Chromium и запрос; автоматический сбор остановлен.', 'page_layout_changed')
      }
      this.status = 'collecting'
      const newCards = initial.filter((card) => !this.seen.has(card.sourceCardId))
      if (newCards.length) this.pending = await this.preparePage(newCards)
      return this.snapshot()
    } catch (error) {
      return this.stopForAttention(error instanceof Error ? error.message : 'Не удалось открыть 2ГИС.', 'browser_start_failed')
    }
  }

  async nextPage(): Promise<PendingPage | null> {
    if (this.pending) return this.pending
    if (this.status !== 'collecting' || !this.page) return null
    if (this.pageIndex >= this.request.maxPages) return this.stopAtLimit('page_limit_reached')
    if (this.rawFound >= this.request.maxCandidates) return this.stopAtLimit('candidate_limit_reached')
    if (this.stopAfterThisPage) return this.finishAtTarget()

    let before = await this.extractVisibleCards()
    let unseen = before.filter((card) => !this.seen.has(card.sourceCardId))
    // If the visible page changed outside the collector, save it before advancing again.
    if (unseen.length) {
      this.pending = await this.preparePage(unseen)
      return this.pending
    }

    const delayMs = 2_500 + Math.floor(Math.random() * 2_001)
    await this.page.waitForTimeout(delayMs)
    const delayedProtection = await this.detectProtection()
    if (delayedProtection) {
      this.stopForAttention(delayedProtection.message, delayedProtection.reason)
      return this.pending
    }
    before = await this.extractVisibleCards()
    unseen = before.filter((card) => !this.seen.has(card.sourceCardId))
    if (unseen.length) {
      this.pending = await this.preparePage(unseen)
      return this.pending
    }

    const beforeIds = new Set(before.map((card) => card.sourceCardId))
    const startingUrl = this.page.url()
    const nextPageUrl = this.retryPageUrl ?? buildTwoGisNextPageUrl(startingUrl)
    let after: ExtractedCard[] = before

    // Prefer the directory's visible controls so its own pagination state stays in sync.
    let advanced = await this.clickLoadMore()
    if (advanced) after = await this.waitForNewCards(beforeIds, maxWaitMs)
    if (this.status === 'collecting' && !this.hasNewCards(after, beforeIds) && this.page.url() === startingUrl) {
      advanced = await this.clickNextPage()
      if (advanced) after = await this.waitForNewCards(beforeIds, maxWaitMs)
    }
    if (this.status === 'collecting' && !this.hasNewCards(after, beforeIds) && this.page.url() === startingUrl) {
      await this.scrollResults()
      after = await this.waitForNewCards(beforeIds, 1_500)
    }

    // A validated URL is the bounded fallback when the rendered controls do not advance.
    if (this.status === 'collecting' && !this.hasNewCards(after, beforeIds)
      && nextPageUrl && this.page.url() === startingUrl) {
      this.retryPageUrl = nextPageUrl
      await this.page.goto(nextPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const blocked = await this.detectProtection()
      if (blocked) {
        this.stopForAttention(blocked.message, blocked.reason)
        return this.pending
      }
      after = await this.waitForNewCards(beforeIds, maxWaitMs)
    }

    if (this.status !== 'collecting') return this.pending

    const newCards = after.filter((card) => !this.seen.has(card.sourceCardId))
    if (!newCards.length) {
      this.status = 'partially_completed'
      this.emptyResultRetries += 1
      this.retryPageUrl = buildTwoGisNextPageUrl(this.page.url())
      this.canContinue = this.emptyResultRetries < maxEmptyResultRetries
      this.stopReason = this.canContinue ? 'visible_results_exhausted' : 'visible_results_exhausted_limit'
      this.message = this.canContinue
        ? `За ${maxWaitMs / 1000} секунд новые карточки не появились (попытка ${this.emptyResultRetries} из ${maxEmptyResultRetries}). Chromium оставлен открытым; можно повторить загрузку.`
        : `Новые карточки не появились после ${maxEmptyResultRetries} попыток. Выдача может быть закончена; сбор остановлен.`
      if (!this.canContinue) await this.closeBrowser()
      return null
    }
    this.emptyResultRetries = 0
    this.retryPageUrl = null
    this.pending = await this.preparePage(newCards)
    return this.pending
  }

  acknowledge(pageId: string): LocalJobSnapshot {
    if (!this.pending || this.pending.pageId !== pageId) throw new Error('Страница уже сохранена или ID страницы неверен.')
    this.rawFound += this.pending.cards.length
    this.pageIndex += 1
    const completeTarget = this.request.requestedCount > 0 && this.rawFound >= this.request.requestedCount
    const page = this.pending
    this.pending = null
    if (this.status === 'needs_attention' && this.stopReason === 'captcha_manual') {
      if (completeTarget) {
        this.status = 'ready_for_review'
        this.message = 'Желаемое количество исходных карточек собрано.'
        this.stopReason = 'requested_count_reached'
        this.canContinue = false
        void this.closeBrowser()
      }
      return this.snapshot()
    }
    if (completeTarget) {
      this.status = 'ready_for_review'
      this.message = 'Желаемое количество исходных карточек собрано.'
      this.stopReason = 'requested_count_reached'
      void this.closeBrowser()
    } else if (!page.hasMore && page.stopReason) {
      this.status = 'partially_completed'
      this.message = page.limitations[0] ?? 'Сбор остановлен по техническому ограничению.'
      this.stopReason = page.stopReason
      this.canContinue = page.stopReason === 'page_limit_reached' || page.stopReason === 'candidate_limit_reached'
      if (!this.canContinue) void this.closeBrowser()
    } else if (!page.hasMore) {
      this.status = 'partially_completed'
      this.message = 'Достигнута видимая граница выдачи. Полный каталог города этим не подтверждается.'
      this.stopReason = 'ranked_results_exhausted'
      void this.closeBrowser()
    }
    return this.snapshot()
  }

  async continue(additionalPages: number, additionalCandidates: number): Promise<LocalJobSnapshot> {
    const retryVisibleResults = this.status === 'partially_completed'
      && this.stopReason === 'visible_results_exhausted' && this.canContinue
    if (retryVisibleResults) {
      this.status = 'collecting'
      this.stopReason = null
      this.message = 'Повторяем загрузку результатов по вашей команде.'
      this.canContinue = false
      return this.snapshot()
    }
    const manualCaptchaResume = this.status === 'needs_attention' && this.stopReason === 'captcha_manual' && this.canContinue
    if (manualCaptchaResume) {
      const page = this.page
      if (!page || page.isClosed() || !this.browser?.isConnected()) {
        return this.stopForAttention('Окно Chromium закрыто. Сохранённые карточки остались в локальном пакете; запустите продолжение, чтобы открыть новое окно.', 'browser_closed')
      }
      const protection = await this.detectProtection(this.detailPage ?? this.page)
      if (protection) return this.stopForAttention(protection.message, protection.reason)

      let visible: ExtractedCard[]
      try {
        visible = await this.extractVisibleCards()
        const deadline = Date.now() + maxWaitMs
        while (!visible.length && Date.now() < deadline) {
          await page.waitForTimeout(500)
          const delayedProtection = await this.detectProtection()
          if (delayedProtection) return this.stopForAttention(delayedProtection.message, delayedProtection.reason)
          visible = await this.extractVisibleCards()
        }
      }
      catch { return this.stopForAttention('Не удалось прочитать страницу после ручной проверки. Сохранённые карточки остались в пакете.', 'page_layout_changed') }
      const newCards = visible.filter((card) => !this.seen.has(card.sourceCardId))
      this.status = 'collecting'
      this.stopReason = null
      this.message = 'Проверка пройдена вручную. Нажмите «Следующая страница», чтобы продолжить сбор.'
      this.canContinue = false
      if (newCards.length) this.pending = await this.preparePage(newCards)
      return this.snapshot()
    }
    if (!this.canContinue || this.status !== 'partially_completed') throw new Error('Этот локальный сбор нельзя продолжить.')
    if (!Number.isSafeInteger(additionalPages) || additionalPages < 1 || additionalPages > 50
      || !Number.isSafeInteger(additionalCandidates) || additionalCandidates < 1 || additionalCandidates > 5000) {
      throw new Error('Для продолжения укажите от 1 до 50 страниц и от 1 до 5000 карточек.')
    }
    this.request.maxPages += additionalPages
    this.request.maxCandidates += additionalCandidates
    this.canContinue = false
    this.stopReason = null
    this.message = null
    if (!this.page || !this.browser) {
      this.browser = await chromium.launch({ headless: false })
      const context = await this.browser.newContext({ locale: 'ru-RU' })
      this.page = await context.newPage()
      this.page.setDefaultTimeout(5_000)
      await this.page.goto(buildTwoGisSearchUrl(this.request.niche, this.request.city), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.page.waitForTimeout(3_000)
      const blocked = await this.detectProtection()
      if (blocked) return this.stopForAttention(blocked.message, blocked.reason)
      const allCards = await this.extractVisibleCards()
      for (const card of allCards) this.seen.add(card.sourceCardId)
      if (!allCards.length) return this.stopForAttention('Не удалось восстановить выдачу 2ГИС после перезапуска браузера.', 'resume_failed')
    }
    this.status = 'collecting'
    return this.snapshot()
  }

  async cancel(): Promise<LocalJobSnapshot> {
    this.status = 'cancelled'
    this.message = 'Сбор отменён пользователем. Уже сохранённые карточки остались в локальном пакете.'
    this.stopReason = 'user_cancelled'
    this.canContinue = false
    this.pending = null
    await this.closeBrowser()
    return this.snapshot()
  }

  async dispose(): Promise<void> { await this.closeBrowser() }

  snapshot(): LocalJobSnapshot {
    return { jobId: this.jobId, runId: this.runId, status: this.status, pageIndex: this.pageIndex,
      rawFound: this.rawFound, message: this.message, stopReason: this.stopReason, canContinue: this.canContinue }
  }

  private async preparePage(cards: ExtractedCard[]): Promise<PendingPage | null> {
    const room = this.request.maxCandidates - this.rawFound
    const wanted = this.request.requestedCount > 0 ? this.request.requestedCount - this.rawFound : room
    const kept: ExtractedCard[] = []
    for (const card of cards.slice(0, Math.max(0, Math.min(room, wanted)))) {
      const checked = await this.checkFullCard(card)
      if (this.status !== 'collecting' && this.status !== 'starting') break
      kept.push(checked)
      this.onCard?.(this.toSourceCard(checked))
    }
    if (!kept.length) return null
    for (const card of kept) this.seen.add(card.sourceCardId)
    const countReached = this.request.requestedCount > 0 && this.rawFound + kept.length >= this.request.requestedCount
    const candidateLimitReached = this.rawFound + kept.length >= this.request.maxCandidates
    const pageLimitReached = this.pageIndex + 1 >= this.request.maxPages
    const stopReason = countReached ? 'requested_count_reached'
      : candidateLimitReached ? 'candidate_limit_reached'
        : pageLimitReached ? 'page_limit_reached' : null
    this.stopAfterThisPage = countReached
    return {
      pageId: randomUUID(), pageIndex: this.pageIndex, cards: kept.map((card) => this.toSourceCard(card)),
      hasMore: !stopReason,
      sourceComplete: false,
      reportedTotal: null,
      limitations: this.request.requestedCount === 0
        ? ['Сбор ограничен техническими пределами и видимой выдачей 2ГИС; полный каталог не гарантируется.']
        : [],
      stopReason,
    }
  }

  private toSourceCard(card: ExtractedCard): SourceCompanyCard {
    return {
      sourceCardId: card.sourceCardId,
      sourceNetworkId: null,
      sourceName: card.companyName,
      companyName: card.companyName,
      city: this.request.city,
      address: card.address,
      niche: this.request.niche,
      phone: card.phone,
      website: card.website,
      websiteCheckStatus: card.websiteCheckStatus ?? 'unknown',
      websiteCheckVersion: card.websiteCheckVersion,
      websiteCheckedAt: card.websiteCheckedAt,
      websiteCheckedSourceUrl: card.websiteCheckedSourceUrl,
      sourceUrl: card.sourceUrl,
      rating: card.rating,
      reviewCount: card.reviewCount,
      latitude: null,
      longitude: null,
    }
  }

  private async checkFullCard(card: ExtractedCard): Promise<ExtractedCard> {
    if (!this.page) return { ...card, websiteCheckStatus: 'unknown' }
    try {
      if (!this.detailPage || this.detailPage.isClosed()) this.detailPage = await this.page.context().newPage()
      const detail = this.detailPage
      detail.setDefaultTimeout(3_000)
      // /tab/info is business information, not Contacts. It can hide every site.
      await detail.goto(card.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 8_000 })
      const initialProtection = await this.detectProtection(detail)
      if (initialProtection) {
        this.stopForAttention(initialProtection.message, initialProtection.reason)
        return { ...card, websiteCheckStatus: 'unknown' }
      }
      await detail.locator('h1').first().waitFor({ state: 'visible', timeout: 3_000 })
      await detail.waitForTimeout(1_500)
      const protection = await this.detectProtection(detail)
      if (protection) {
        this.stopForAttention(protection.message, protection.reason)
        return { ...card, websiteCheckStatus: 'unknown' }
      }
      if (parseTwoGisFirmUrl(detail.url())?.sourceCardId !== card.sourceCardId) return { ...card, websiteCheckStatus: 'unknown' }
      const contacts = await detail.evaluate(() => ({
        phone: document.querySelector<HTMLAnchorElement>('a[href^="tel:"]')?.getAttribute('href')?.replace(/^tel:/i, '') ?? null,
        address: document.querySelector<HTMLElement>('[itemprop="streetAddress"], [data-testid*="address" i], [class*="address" i]')?.innerText.trim() || null,
      }))
      card = { ...card, phone: contacts.phone ?? card.phone, address: contacts.address ?? card.address }
      const deadline = Date.now() + maxWaitMs
      let absentSince: number | null = null
      while (Date.now() < deadline) {
        const expand = detail.getByRole('button', { name: /^(?:показать (?:все )?контакты|другие контакты|все ссылки)$/i }).first()
        if (await expand.isVisible().catch(() => false) && await expand.getAttribute('aria-expanded') !== 'true') {
          await expand.click({ timeout: 1500 }).catch(() => undefined)
          absentSince = null
        }
        const result = await detail.evaluate(readTwoGisContacts)
        if (result.websiteCheckStatus === 'present') return { ...card, ...result }
        if (result.websiteCheckStatus === 'absent') {
          absentSince ??= Date.now()
          if (Date.now() - absentSince >= 2500) return { ...card, ...result,
            websiteCheckVersion: currentWebsiteCheckVersion, websiteCheckedAt: new Date().toISOString(),
            websiteCheckedSourceUrl: card.sourceUrl }
        } else absentSince = null
        await detail.waitForTimeout(500)
        const blocked = await this.detectProtection(detail)
        if (blocked) { this.stopForAttention(blocked.message, blocked.reason); break }
      }
      return { ...card, websiteCheckStatus: 'unknown' }
    } catch {
      const protection = this.detailPage ? await this.detectProtection(this.detailPage).catch(() => null) : null
      if (protection) this.stopForAttention(protection.message, protection.reason)
      const failedDetail = this.detailPage
      this.detailPage = null
      await failedDetail?.close().catch(() => undefined)
      return { ...card, websiteCheckStatus: 'unknown' }
    }
  }

  private async extractVisibleCards(): Promise<ExtractedCard[]> {
    if (!this.page) return []
    const visible = await this.page.evaluate(() => {
      const output: Array<Omit<ExtractedCard, 'sourceCardId' | 'sourceUrl'> & { href: string }> = []
      const seen = new Set<string>()
      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/firm/"]'))) {
        const url = new URL(anchor.href, location.href)
        if (url.hostname !== '2gis.ru' && url.hostname !== 'www.2gis.ru') continue
        const match = url.pathname.match(/\/firm\/(\d+)(?:\/|$)/i)
        if (!match || seen.has(match[1])) continue
        let card = anchor.closest<HTMLElement>('[data-testid*="result" i], [data-role*="result" i], [role="listitem"], article')
        if (!card || card.querySelectorAll('a[href*="/firm/"]').length > 1) {
          let ancestor = anchor.parentElement
          for (let level = 0; ancestor && level < 7; level += 1, ancestor = ancestor.parentElement) {
            if (ancestor.querySelectorAll('a[href*="/firm/"]').length === 1) { card = ancestor; break }
          }
        }
        card ??= anchor.parentElement?.parentElement ?? anchor.parentElement
        const title = card?.querySelector<HTMLElement>('h1, h2, h3, [data-testid*="title" i], [class*="title" i], [class*="name" i]')?.innerText
        const anchorFirstLine = (anchor.innerText || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
        const name = (title || anchorFirstLine || anchor.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')
        if (!name) continue
        seen.add(match[1])
        const address = card?.querySelector<HTMLElement>('[data-testid*="address" i], [class*="address" i], [aria-label*="адрес" i]')?.innerText.trim() || null
        const phone = card?.querySelector<HTMLAnchorElement>('a[href^="tel:"]')?.getAttribute('href')?.replace(/^tel:/i, '') || null
        const cardText = card?.innerText ?? ''
        const ratingText = card?.querySelector<HTMLElement>('[aria-label*="оцен" i], [class*="rating" i]')?.innerText ?? ''
        const ratingMatch = `${ratingText} ${cardText}`.match(/(?:^|\s)([0-5][,.]\d)(?:\s|$)/)
        const reviewMatch = cardText.match(/(\d+)\s*(?:оцен(?:ок|ки)?|отзыв(?:ов|а)?)/i)
        output.push({ href: url.toString(), companyName: name, address, phone, website: null,
          rating: ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null,
          reviewCount: reviewMatch ? Number(reviewMatch[1]) : null })
      }
      return output
    })
    return visible.flatMap(({ href, ...fields }) => {
      const cardUrl = parseTwoGisFirmUrl(href)
      return cardUrl ? [{ ...fields, ...cardUrl }] : []
    })
  }

  private async clickLoadMore(): Promise<boolean> {
    if (!this.page) return false
    const buttons = await this.page.locator('button').all()
    for (const button of buttons) {
      const label = (await button.innerText().catch(() => '')).trim().toLocaleLowerCase('ru-RU')
      if (!/показать\s+ещ[её]|ещ[её]\s+результат|больше\s+результат|загрузить\s+ещ[её]/.test(label)) continue
      try {
        if (!await button.isVisible() || !await button.isEnabled()) continue
        await button.click({ timeout: 2_000 })
        return true
      } catch { continue }
    }
    return false
  }

  private async clickNextPage(): Promise<boolean> {
    if (!this.page) return false
    const currentUrl = new URL(this.page.url())
    const currentMatch = currentUrl.pathname.match(/^(.*\/search\/.+)\/page\/(\d+)$/i)
    const searchPath = currentMatch ? currentMatch[1] : currentUrl.pathname.replace(/\/+$/, '')
    const currentPage = currentMatch ? Number(currentMatch[2]) : 1
    const pageLinks = await this.page.locator('a[href*="/page/"]').all()
    const nextLinks: Array<{ page: number; link: (typeof pageLinks)[number] }> = []
    for (const link of pageLinks) {
      const href = await link.getAttribute('href').catch(() => null)
      if (!href) continue
      try {
        const url = new URL(href, currentUrl)
        const match = url.pathname.match(/^(.*\/search\/.+)\/page\/(\d+)$/i)
        if (url.origin === currentUrl.origin && match?.[1] === searchPath && Number(match[2]) > currentPage) {
          nextLinks.push({ page: Number(match[2]), link })
        }
      } catch { continue }
    }
    nextLinks.sort((left, right) => left.page - right.page)
    for (const { link } of nextLinks) {
      try {
        if (!await link.isVisible() || !await link.isEnabled()) continue
        await link.click({ timeout: 2_000 })
        return true
      } catch { continue }
    }

    const controls = await this.page.locator('button, a, [role="button"]').all()
    const explicitPageLabel = /^(?:next\s+page|следующ(?:ая|ую)\s+страниц(?:а|у)|перейти\s+на\s+следующую\s+страницу)$/iu
    for (const control of controls) {
      const labels = [
        await control.innerText().catch(() => ''),
        await control.getAttribute('aria-label').catch(() => null),
        await control.getAttribute('title').catch(() => null),
      ].filter(Boolean).map((label) => label!.replace(/\s+/g, ' ').trim())
      if (!labels.some((label) => explicitPageLabel.test(label))) continue
      try {
        if (!await control.isVisible() || !await control.isEnabled()) continue
        await control.click({ timeout: 2_000 })
        return true
      } catch { continue }
    }

    const paginationGroups = await this.page.locator(
      'nav[aria-label*="pagination" i], nav[aria-label*="страниц" i], [data-testid*="pagination" i], [class*="pagination" i]',
    ).all()
    for (const group of paginationGroups) {
      const groupControls = await group.locator('button, a, [role="button"]').all()
      const labels: string[] = []
      let currentIndex = -1
      let currentPageNumber: number | null = null
      for (let index = 0; index < groupControls.length; index += 1) {
        const control = groupControls[index]
        const label = (await control.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        labels.push(label)
        const ariaCurrent = await control.getAttribute('aria-current').catch(() => null)
        const className = await control.getAttribute('class').catch(() => '')
        if ((ariaCurrent && ariaCurrent !== 'false') || /(?:^|[-_\s])(?:active|current|selected)(?:$|[-_\s])/i.test(className ?? '')) {
          currentIndex = index
          currentPageNumber = /^\d+$/.test(label) ? Number(label) : null
        }
      }

      const groupNextLabel = /^(?:next(?:\s+page)?|следующ(?:ая|ую)(?:\s+страниц(?:а|у))?|далее|впер[её]д|>|»|›|→)$/iu
      let nextIndex = groupControls.findIndex((_control, index) => index !== currentIndex
        && groupNextLabel.test(labels[index]))
      if (nextIndex < 0 && currentIndex >= 0) {
        nextIndex = groupControls.findIndex((_control, index) => index > currentIndex
          && /^\d+$/.test(labels[index])
          && (currentPageNumber === null || Number(labels[index]) > currentPageNumber))
      }
      if (nextIndex < 0) continue
      try {
        const control = groupControls[nextIndex]
        if (!await control.isVisible() || !await control.isEnabled()) continue
        await control.click({ timeout: 2_000 })
        return true
      } catch { continue }
    }
    return false
  }

  private hasNewCards(cards: ExtractedCard[], previousIds: ReadonlySet<string>): boolean {
    return cards.some((card) => !previousIds.has(card.sourceCardId))
  }

  private async waitForNewCards(previousIds: ReadonlySet<string>, timeoutMs: number): Promise<ExtractedCard[]> {
    if (!this.page) return []
    const deadline = Date.now() + timeoutMs
    let cards = await this.extractVisibleCards()
    while (!this.hasNewCards(cards, previousIds) && Date.now() < deadline) {
      const blocked = await this.detectProtection()
      if (blocked) {
        this.stopForAttention(blocked.message, blocked.reason)
        return cards
      }
      await this.page.waitForTimeout(400)
      cards = await this.extractVisibleCards()
    }
    return cards
  }

  private async scrollResults(): Promise<void> {
    if (!this.page) return
    await this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((element) => element.scrollHeight > element.clientHeight + 150
          && element.clientHeight > 150 && element.querySelector('a[href*="/firm/"]'))
        .sort((a, b) => b.clientHeight - a.clientHeight)
      const panel = candidates[0]
      if (panel) panel.scrollBy(0, Math.max(panel.clientHeight * 0.8, 500))
      else window.scrollBy(0, Math.max(window.innerHeight * 0.8, 500))
    })
  }

  private async detectProtection(page: Page | null = this.page): Promise<ProtectionDetection | null> {
    if (!page) return null
    const pageText = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
    const hasCaptcha = await page.locator('input[name*="captcha" i]:visible, iframe[src*="captcha" i]:visible, [class*="captcha" i]:visible').count().catch(() => 0)
    const url = page.url()
    const content = `${url} ${pageText.slice(0, 3000)}`
    if (hasCaptcha || /showcaptcha|checkcaptcha/i.test(url) || captchaText.test(content)) {
      return {
        reason: 'captcha_manual',
        message: '2ГИС запросил CAPTCHA. Решите её вручную в открытом Chromium, затем нажмите «Проверить CAPTCHA и продолжить». Сбор пока на паузе; сохранённые карточки доступны в пакете.',
      }
    }
    if (accessRestrictionText.test(content)) return {
      reason: 'access_restricted',
      message: '2ГИС ограничил доступ или частоту запросов. Сбор остановлен; сохранённые карточки доступны в пакете.',
    }
    return null
  }

  private stopAtLimit(reason: 'page_limit_reached' | 'candidate_limit_reached'): null {
    this.status = 'partially_completed'
    this.stopReason = reason
    this.message = reason === 'page_limit_reached' ? 'Достигнут лимит страниц этого этапа.' : 'Достигнут лимит карточек этого этапа.'
    this.canContinue = true
    return null
  }

  private finishAtTarget(): null {
    this.status = 'ready_for_review'
    this.stopReason = 'requested_count_reached'
    this.message = 'Желаемое количество исходных карточек собрано.'
    void this.closeBrowser()
    return null
  }

  private stopForAttention(message: string, reason: string): LocalJobSnapshot {
    this.status = 'needs_attention'
    this.message = message
    this.stopReason = reason
    this.canContinue = reason === 'captcha_manual' && Boolean(this.browser?.isConnected() && this.page && !this.page.isClosed())
    if (!this.canContinue) void this.closeBrowser()
    return this.snapshot()
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.page = null
    this.detailPage = null
    if (browser) await browser.close().catch(() => undefined)
  }
}

export function buildTwoGisSearchUrl(niche: string, city: string): string {
  return `https://2gis.ru/search/${encodeURIComponent(`${niche.trim()} ${city.trim()}`)}`
}

export function buildTwoGisNextPageUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['2gis.ru', 'www.2gis.ru'].includes(url.hostname.toLocaleLowerCase('en-US'))) return null
    const pathname = url.pathname.replace(/\/+$/, '')
    const pageMatch = pathname.match(/^(.*\/search\/.+)\/page\/(\d+)$/i)
    const searchPath = pageMatch ? pageMatch[1] : pathname
    const currentPage = pageMatch ? Number(pageMatch[2]) : 1
    if (!/\/search\/.+/i.test(searchPath) || !Number.isSafeInteger(currentPage) || currentPage < 1) return null
    url.pathname = `${searchPath}/page/${currentPage + 1}`
    return url.toString()
  } catch {
    return null
  }
}

export function parseTwoGisFirmUrl(value: string): { sourceCardId: string; sourceUrl: string } | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['2gis.ru', 'www.2gis.ru'].includes(url.hostname.toLocaleLowerCase('en-US'))) return null
    const match = url.pathname.match(/\/firm\/(\d+)(?:\/|$)/i)
    if (!match) return null
    return { sourceCardId: match[1], sourceUrl: `https://2gis.ru${url.pathname.slice(0, match.index!)}${match[0].replace(/\/+$/, '')}` }
  } catch {
    return null
  }
}

