import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTwoGisSearchUrl, parseTwoGisFirmUrl, TwoGisLocalJob } from '../src/twoGisMaps.ts'
import { chromium } from 'playwright'
import { readTwoGisContacts } from '../src/twoGisWebsite.ts'
import type { SourceCompanyCard } from '../../src/imports/source.ts'

test('a broken contact tab is recreated and the following card is collected', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const progress: SourceCompanyCard[] = []
  const job = new TwoGisLocalJob({ runId: 'fixture', city: 'Kazan', niche: 'Cafe', requestedCount: 2 }, (card) => progress.push(card))
  try {
    await context.route('https://2gis.ru/**', async (route) => {
      if (route.request().url().endsWith('/firm/1')) return route.abort('failed')
      return route.fulfill({ contentType: 'text/html', body: '<h1>Company</h1><a href="https://company.example">Website</a>' })
    })
    Object.assign(job, { browser, page: await context.newPage(), status: 'collecting' })
    const cards = ['1', '2'].map((id) => ({ sourceCardId: id, sourceUrl: `https://2gis.ru/kazan/firm/${id}`,
      companyName: `Company ${id}`, address: null, phone: null, website: null, rating: null, reviewCount: null }))
    const collector = job as unknown as { preparePage(input: typeof cards): Promise<{ cards: SourceCompanyCard[] }> }
    const result = await collector.preparePage(cards)
    assert.equal(result.cards.length, 2)
    assert.equal(progress[0].websiteCheckStatus, 'unknown')
    assert.equal(progress[1].websiteCheckStatus, 'present')
    assert.equal(progress[1].website, 'https://company.example/')
    assert.equal(job.status, 'collecting')
  } finally { await job.dispose() }
})

test('the collector switches result pages and reports each saved card before page acknowledgement', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const progress: SourceCompanyCard[] = []
  const job = new TwoGisLocalJob({ runId: 'fixture', city: 'Kazan', niche: 'Cafe', requestedCount: 1, knownCardIds: ['1'] },
    (card) => progress.push(card))
  try {
    await context.route('https://2gis.ru/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.includes('/firm/')) return route.fulfill({ contentType: 'text/html',
        body: '<h1>Company</h1><a href="https://company.example">Website</a>' })
      const next = url.pathname.endsWith('/page/2')
      return route.fulfill({ contentType: 'text/html', body: `<article><h2>Company ${next ? 2 : 1}</h2><a href="/kazan/firm/${next ? 2 : 1}">Company</a></article>
        ${next ? '' : '<a href="/kazan/search/Cafe/page/2">Next page</a>'}` })
    })
    const page = await context.newPage()
    await page.goto('https://2gis.ru/kazan/search/Cafe')
    Object.assign(job, { browser, page, status: 'collecting' })
    const result = await job.nextPage()
    assert.equal(page.url(), 'https://2gis.ru/kazan/search/Cafe/page/2')
    assert.equal(result?.cards[0].sourceCardId, '2')
    assert.deepEqual(progress.map((card) => card.sourceCardId), ['2'])
    assert.equal(job.rawFound, 0)
    assert.equal(job.acknowledge(result!.pageId).status, 'ready_for_review')
  } finally { await job.dispose() }
})

test('full rendered contacts distinguish website, verified absence and incomplete checks', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('https://2gis.ru/**', (route) => route.fulfill({ contentType: 'text/html', body: '<body></body>' }))
    await page.goto('https://2gis.ru/kazan/firm/123')
    const check = async (contacts: string, wrapper = true) => {
      await page.setContent(wrapper
        ? `<section><h1>Кофейня</h1><nav><a href="/kazan/firm/123">Контакты</a><a href="/kazan/firm/123/tab/info">Инфо</a></nav>${contacts}<button>Нашли ошибку в данных?</button></section><footer><a href="https://directory.example">Сайт каталога</a></footer>`
        : contacts)
      return page.evaluate(readTwoGisContacts)
    }
    assert.deepEqual(await check('<a href="tel:+79991234567">Телефон</a>'), { website: null, websiteCheckStatus: 'absent' })
    for (const href of ['https://example.org/menu', 'https://link.2gis.ru/?url=https%3A%2F%2Fexample.org%2Fmenu',
      'http://link.2gis.ru/1.2/tracker?https://example.org/menu', 'https://link.2gis.ru/1.2/tracker?https%3A%2F%2Fexample.org%2Fmenu']) {
      assert.deepEqual(await check(`<a href="${href}">Сайт</a>`), { website: 'https://example.org/menu', websiteCheckStatus: 'present' })
    }
    assert.equal((await check('<a href="https://example.org">example.org</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="tel:1234567">Телефон</a><button data-testid="website">Сайт</button>')).websiteCheckStatus, 'unknown')
    assert.equal((await check('<a href="tel:1234567">Телефон</a><a href="https://link.2gis.ru/?url=%25%25">Сайт</a>')).websiteCheckStatus, 'unknown')
    assert.equal((await check('<div role="progressbar">Загрузка</div><a href="tel:1234567">Телефон</a>')).websiteCheckStatus, 'unknown')
    assert.equal((await check('')).websiteCheckStatus, 'unknown')
    assert.equal((await check('<h1>Капча</h1>', false)).websiteCheckStatus, 'unknown')
    assert.equal((await check('<a href="https://vk.com/company">ВКонтакте</a><a href="tel:1234567">Телефон</a>')).websiteCheckStatus, 'absent')
    assert.equal((await check('<a href="tel:1234567">Телефон</a><a style="display:none" href="https://hidden.example">Сайт</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://company.example">Подробнее</a><a href="tel:1234567">Телефон</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://company.example/?url=https://t.me/company">Перейти</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://company.business.site">Сайт</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://company.taplink.cc">Taplink</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://yandex.ru/site/company">Страница компании</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://youtube.com.evil.example">YouTube</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<button data-href="https://company.example">Открыть</button>')).websiteCheckStatus, 'present')
    assert.equal((await check('<button data-url="company.example">Открыть</button>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://l.instagram.com/?u=https%3A%2F%2Fcompany.example">Instagram</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://youtube.com/redirect?q=https%3A%2F%2Fcompany.example">YouTube</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="https://2gis.ru/redirect?url=https%3A%2F%2Fcompany.example">Подробнее</a>')).websiteCheckStatus, 'present')
    assert.equal((await check('<a href="tel:1234567">Телефон</a><button>Ещё</button>')).websiteCheckStatus, 'unknown')
    for (const href of ['https://t.me/company', 'https://instagram.com/company', 'https://youtube.com/@company',
      'https://youtu.be/abc', 'https://vk.com/company', 'https://rutube.ru/channel/123', 'https://max.ru/company',
      'https://link.2gis.ru/1.2/tracker?https://t.me/company']) {
      assert.equal((await check(`<a href="${href}">Контакт</a>`)).websiteCheckStatus, 'absent', href)
      assert.equal((await check(`<a href="${href}">Контакт</a><a href="https://company.example">Подробнее</a>`)).websiteCheckStatus, 'present', href)
    }
    assert.equal((await check('<section><header><h1>Кофейня</h1><nav><a href="/kazan/firm/123">Контакты</a></nav><a href="tel:1234567">Телефон</a></header><aside><a href="https://outside-header.example">Подробнее</a></aside><button>Нашли ошибку в данных?</button></section>', false)).websiteCheckStatus, 'present')
    assert.equal((await check('<section><h1>Кофейня</h1><a href="/kazan/firm/123">Контакты</a><a href="tel:1234567">Телефон</a></section>', false)).websiteCheckStatus, 'unknown')
    await page.goto('https://2gis.ru/kazan/firm/123/tab/info')
    assert.equal((await check('<a href="tel:1234567">Телефон</a>')).websiteCheckStatus, 'unknown', 'Info tab must never prove absence')
  } finally { await browser.close() }
})

test('2GIS search URL encodes the requested niche and city', () => {
  const url = new URL(buildTwoGisSearchUrl('Стоматологии', 'Казань'))
  assert.equal(url.origin, 'https://2gis.ru')
  assert.equal(decodeURIComponent(url.pathname), '/search/Стоматологии Казань')
})

test('firm checking visits Contacts and catches normal and delayed sites while allowing social-only contacts', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const visited: string[] = []
  const job = new TwoGisLocalJob({ runId: 'fixture', city: 'Казань', niche: 'Кафе', requestedCount: 3 })
  try {
    await context.route('https://2gis.ru/**', async (route) => {
      const url = new URL(route.request().url())
      visited.push(url.pathname)
      const id = url.pathname.match(/\/firm\/(\d+)/)?.[1] ?? '0'
      const website = id === '101' ? '<a href="http://link.2gis.ru/1.2/tracker?http://company.example">Подробнее</a>' : ''
      const delayed = id === '103' ? '<script>setTimeout(() => { const a=document.createElement("a");a.href="https://late.example";a.textContent="Перейти";document.getElementById("links").append(a) },2800)</script>' : ''
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<section><h1>Компания ${id}</h1><nav><a href="/kazan/firm/${id}">Контакты</a><a href="/kazan/firm/${id}/tab/info">Инфо</a></nav><div id="links"><a href="https://t.me/company">Telegram</a><a href="https://instagram.com/company">Instagram</a><a href="https://youtube.com/@company">YouTube</a>${website}</div><button>Нашли ошибку в данных?</button></section>${delayed}` })
    })
    // Inject an isolated headless browser into the adapter; the actual firm
    // reader, navigation, waits, protection detection and proof stamping run.
    Object.assign(job, { browser, page: await context.newPage(), status: 'collecting' })
    type Card = { sourceCardId: string; sourceUrl: string; companyName: string; address: null; phone: null; website: string | null; rating: null; reviewCount: null }
    const checker = job as unknown as { checkFullCard(card: Card): Promise<Card & { websiteCheckStatus: string; websiteCheckVersion?: number; websiteCheckedSourceUrl?: string; websiteCheckedAt?: string }> }
    const input = (id: string): Card => ({ sourceCardId: id, sourceUrl: `https://2gis.ru/kazan/firm/${id}`, companyName: `Компания ${id}`, address: null, phone: null, website: null, rating: null, reviewCount: null })
    assert.equal((await checker.checkFullCard(input('101'))).websiteCheckStatus, 'present')
    const socialOnly = await checker.checkFullCard(input('102'))
    assert.equal(socialOnly.websiteCheckStatus, 'absent')
    assert.equal(socialOnly.website, null)
    assert.equal(socialOnly.websiteCheckVersion, 2)
    assert.equal(socialOnly.websiteCheckedSourceUrl, 'https://2gis.ru/kazan/firm/102')
    assert.ok(Number.isFinite(Date.parse(socialOnly.websiteCheckedAt!)))
    const late = await checker.checkFullCard(input('103'))
    assert.equal(late.websiteCheckStatus, 'present')
    assert.equal(late.website, 'https://late.example/')
    assert.ok(visited.length >= 3)
    assert.equal(visited.some((path) => path.includes('/tab/info')), false)
  } finally { await job.dispose(); await browser.close() }
})

test('2GIS firm links preserve the listing ID and canonical source URL', () => {
  assert.deepEqual(parseTwoGisFirmUrl('https://2gis.ru/kazan/firm/70000001062724179?m=49.1,55.7/16'), {
    sourceCardId: '70000001062724179',
    sourceUrl: 'https://2gis.ru/kazan/firm/70000001062724179',
  })
  assert.deepEqual(parseTwoGisFirmUrl('https://2gis.ru/kazan/firm/123/tab/reviews?foo=bar'), {
    sourceCardId: '123', sourceUrl: 'https://2gis.ru/kazan/firm/123',
  })
})

test('2GIS firm URL parser rejects other hosts and non-firm routes', () => {
  assert.equal(parseTwoGisFirmUrl('https://example.org/kazan/firm/123'), null)
  assert.equal(parseTwoGisFirmUrl('https://2gis.ru/kazan/search/clinics'), null)
  assert.equal(parseTwoGisFirmUrl('javascript:alert(1)'), null)
})
