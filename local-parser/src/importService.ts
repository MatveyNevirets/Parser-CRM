import { randomUUID } from 'node:crypto'
import { classifyCompanies } from '../../src/imports/classify.ts'
import { normalizeSourceCompanyCard } from '../../src/imports/normalize.ts'
import type { ImportCandidate, ImportRun, ImportRunParameters } from '../../src/imports/types.ts'
import type { CandidateFields, ImportCandidatePage, ImportService, PublicationReport } from '../../src/imports/service.ts'
import type { SourceCompanyCard } from '../../src/imports/source.ts'
import type { LocalJobSnapshot } from './contracts.ts'
import { SqliteImportStore } from './sqliteStore.ts'
import { TwoGisLocalSource, type LocalCollectionSession, type LocalCollectionSource } from './localCollectionSource.ts'

export class LocalImportService implements ImportService {
  private readonly jobs = new Map<string, LocalCollectionSession>()
  private readonly workers = new Map<string, Promise<void>>()
  private readonly savedProgress = new Map<string, Set<string>>()
  private readonly lastProgress = new Map<string, number>()
  private closed = false
  private readonly pageOperations = new Map<string, Promise<ImportRun>>()

  constructor(private readonly store: SqliteImportStore, private readonly source: LocalCollectionSource = new TwoGisLocalSource()) {}

  static async open(path?: string): Promise<LocalImportService> {
    const store = await SqliteImportStore.open(path)
    const service = new LocalImportService(store)
    for (const run of store.getInterruptedAutomaticRuns()) {
      service.startWorker(run, false, () => service.continueRun(run.workspaceId, run.id))
    }
    return service
  }

  listRuns(workspaceId: string, limit = 25): Promise<ImportRun[]> { return Promise.resolve(this.store.listRuns(workspaceId, limit)) }
  getRun(workspaceId: string, runId: string): Promise<ImportRun | null> { return Promise.resolve(this.store.getRun(workspaceId, runId)) }
  listCandidates(workspaceId: string, runId: string, page: number, pageSize: number, search?: string): Promise<ImportCandidatePage> {
    const result = this.store.listCandidates(workspaceId, runId, page, pageSize, search)
    return Promise.resolve({ ...result, page, pageSize })
  }

  async startRun(parameters: ImportRunParameters, createdBy: string, automatic = false): Promise<ImportRun> {
    validateParameters(parameters, createdBy)
    const existing = this.store.listRuns(parameters.workspaceId, 100).find((run) => run.status === 'collecting'
      || (run.status === 'needs_attention' && run.stopReason === 'captcha_manual' && this.jobs.get(run.id)?.canContinue))
    if (existing) throw new Error('В этом локальном процессе уже выполняется сбор или ожидается ручное решение CAPTCHA. Сначала продолжите или остановите его.')
    const run = this.store.createRun({ ...parameters, source: '2gis' }, createdBy, automatic)
    this.store.startCollection(run.workspaceId, run.id)
    const job = this.createJob(run)
    if (automatic) {
      this.startWorker(run, true)
      return this.requireRun(run.workspaceId, run.id)
    }
    return this.startJob(run, job)
  }

  private async startJob(run: ImportRun, job: LocalCollectionSession): Promise<ImportRun> {
    try {
      const started = await this.watchJob(job, () => job.start())
      if (this.requireRun(run.workspaceId, run.id).status !== 'collecting') return this.requireRun(run.workspaceId, run.id)
      if (started.status === 'collecting' || started.status === 'needs_attention') return this.collectNextPage(run.workspaceId, run.id)
      return mapSnapshot(this.store, run.workspaceId, run.id, started)
    } catch (error) {
      return this.failJob(run, job, error)
    }
  }

  private createJob(run: ImportRun): LocalCollectionSession {
    const progress = new Set<string>()
    this.savedProgress.set(run.id, progress)
    const remaining = run.requestedCount > 0 ? Math.max(1, run.requestedCount - run.rawFound) : 0
    const job = this.source.createSession({
      runId: run.id, city: run.city, niche: run.niche, requestedCount: remaining,
      maxPages: Math.min(20, 200 - run.currentPage), maxCandidates: Math.min(1000, remaining || 5000 - run.rawFound),
      startPage: run.currentPage + 1,
      knownCardIds: this.store.getSeenSourceCardIds(run.id),
    }, (card: SourceCompanyCard) => {
      if (this.closed || this.jobs.get(run.id) !== job) return
      const current = this.requireRun(run.workspaceId, run.id)
      if (current.status !== 'collecting') return
      this.lastProgress.set(run.id, Date.now())
      const identity = card.sourceCardId ?? card.sourceUrl
      if (identity && progress.has(identity)) return
      const normalized = normalizeSourceCompanyCard(run.source, card, new Date().toISOString(), randomUUID())
      // A partial page updates saved cards without advancing the directory cursor.
      this.store.appendPage(run.workspaceId, run.id, current.currentPage, 1, classifyCompanies([normalized]), false, false)
      if (identity) progress.add(identity)
    })
    this.jobs.set(run.id, job)
    return job
  }

  private async watchJob<T>(job: LocalCollectionSession, action: () => Promise<T>): Promise<T> {
    this.lastProgress.set(job.runId, Date.now())
    let timer: ReturnType<typeof setInterval> | undefined
    const stalled = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (Date.now() - (this.lastProgress.get(job.runId) ?? 0) < 60_000) return
        reject(new Error('Источник не отвечает. Перезапускаем браузер и продолжаем сбор.'))
        void job.dispose().catch(() => {})
      }, 5_000)
    })
    try { return await Promise.race([action(), stalled]) }
    finally { clearInterval(timer) }
  }

  private async failJob(run: ImportRun, job: LocalCollectionSession, error: unknown): Promise<ImportRun> {
    if (this.closed) return run
    const current = this.requireRun(run.workspaceId, run.id)
    if (current.status !== 'collecting') return current
    this.jobs.delete(run.id)
    await job.dispose().catch(() => {})
    return this.store.finishCollection(run.workspaceId, run.id, 'needs_attention', 'source_error',
      error instanceof Error ? `Источник завершил работу с ошибкой: ${error.message}` : 'Источник завершил работу с ошибкой.', false)
  }

  private startWorker(run: ImportRun, start = false, resume?: () => Promise<ImportRun>): void {
    if (this.closed || this.workers.has(run.id)) return
    const worker = this.runWorker(run, start, resume).catch(async (error) => {
      const job = this.jobs.get(run.id)
      if (job && !this.closed) await this.failJob(run, job, error)
    }).finally(() => { this.workers.delete(run.id) })
    this.workers.set(run.id, worker)
  }

  private async runWorker(run: ImportRun, start: boolean, resume?: () => Promise<ImportRun>): Promise<void> {
    if (resume) await resume()
    else if (start) await this.startJob(run, this.jobs.get(run.id)!)
    let failures = 0
    let previousCount = run.rawFound
    while (!this.closed) {
      const current = this.requireRun(run.workspaceId, run.id)
      if (current.rawFound > previousCount) failures = 0
      previousCount = current.rawFound
      if (current.status === 'collecting') {
        await this.collectNextPage(run.workspaceId, run.id)
        continue
      }
      const retryEmpty = current.status === 'partially_completed' && current.stopReason === 'visible_results_exhausted'
      const extend = current.status === 'partially_completed' && ['page_limit_reached', 'candidate_limit_reached'].includes(current.stopReason ?? '')
      const recover = current.status === 'needs_attention' && recoverableReasons.includes(current.stopReason ?? '')
      if (!retryEmpty && !extend && !recover) break
      if (run.requestedCount > 0 && current.rawFound >= run.requestedCount) {
        await this.continueRun(run.workspaceId, run.id)
        break
      }
      if (current.rawFound >= 5000 || current.currentPage >= 200) break
      if (recover && ++failures > 3) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (this.closed || this.requireRun(run.workspaceId, run.id).status !== current.status) break
      await this.continueRun(run.workspaceId, run.id)
    }
  }

  collectNextPage(workspaceId: string, runId: string): Promise<ImportRun> {
    this.requireRun(workspaceId, runId)
    const active = this.pageOperations.get(runId)
    if (active) return active
    const operation = this.collectNextPageOnce(workspaceId, runId)
    this.pageOperations.set(runId, operation)
    const cleanup = () => {
      if (this.pageOperations.get(runId) === operation) this.pageOperations.delete(runId)
    }
    void operation.then(cleanup, cleanup)
    return operation
  }

  private async collectNextPageOnce(workspaceId: string, runId: string): Promise<ImportRun> {
    const run = this.requireRun(workspaceId, runId)
    const job = this.jobs.get(runId)
    if (!job) {
      if (run.status === 'collecting') return this.store.finishCollection(workspaceId, runId, 'needs_attention',
        'local_process_restarted', 'Процесс сбора перезапустился. Локально сохранённые карточки остались в пакете.', false)
      return run
    }
    let page
    try { page = await this.watchJob(job, () => job.nextPage()) }
    catch (error) { return this.failJob(run, job, error) }
    if (this.closed) return run
    const current = this.requireRun(workspaceId, runId)
    if (current.status !== 'collecting') return current
    if (page) {
      const progress = this.savedProgress.get(runId)
      const unsaved = page.cards.filter((card) => !progress?.has(card.sourceCardId ?? card.sourceUrl ?? ''))
      const received = unsaved.map((card) => normalizeSourceCompanyCard(run.source, card, new Date().toISOString(), randomUUID()))
      const classified = classifyCompanies(received)
      this.store.appendPage(workspaceId, runId, current.currentPage, unsaved.length, classified, page.sourceComplete)
      progress?.clear()
      const snapshot = job.acknowledge(page.pageId)
      return mapSnapshot(this.store, workspaceId, runId, snapshot, page.sourceComplete)
    }
    const snapshot = job.snapshot()
    return mapSnapshot(this.store, workspaceId, runId, snapshot)
  }

  async cancelRun(workspaceId: string, runId: string): Promise<ImportRun> {
    const run = this.requireRun(workspaceId, runId)
    const job = this.jobs.get(runId)
    this.jobs.delete(runId)
    const cancelled = this.store.finishCollection(workspaceId, runId, 'cancelled', 'user_cancelled',
      run.status === 'needs_attention' && run.stopReason === 'captcha_manual'
        ? 'Пользователь остановил сбор во время ручной проверки CAPTCHA. Уже сохранённые карточки остались в локальном пакете.'
        : 'Сбор отменён пользователем. Уже сохранённые карточки остались в локальном пакете.', false)
    if (job) await job.cancel().catch(() => {})
    return cancelled
  }

  async continueRun(workspaceId: string, runId: string, automatic = false): Promise<ImportRun> {
    const run = this.requireRun(workspaceId, runId)
    if (!['partially_completed', 'needs_attention'].includes(run.status)) throw new Error('Продолжить можно только остановленный частичный сбор.')
    const currentJob = this.jobs.get(runId)
    const manualCaptchaCanResume = run.stopReason === 'captcha_manual' && currentJob?.canContinue === true
    if (run.status === 'needs_attention' && !recoverableReasons.includes(run.stopReason ?? '') && !manualCaptchaCanResume) {
      throw new Error('Сбор остановлен из-за ограничения доступа или структуры страницы. Продолжение недоступно; сохранённый пакет можно проверить.')
    }
    if (run.status === 'partially_completed'
      && !['page_limit_reached', 'candidate_limit_reached', 'visible_results_exhausted'].includes(run.stopReason ?? '')) {
      throw new Error('Источник не показал дополнительных карточек. Этот сбор нельзя автоматически продолжить.')
    }
    const totalCandidateLimit = run.requestedCount > 0 ? run.requestedCount : 5000
    const remainingCandidates = totalCandidateLimit - run.rawFound
    const remainingPages = 200 - run.currentPage
    if (run.requestedCount > 0 && remainingCandidates < 1) {
      this.store.startCollection(workspaceId, runId)
      return this.store.finishCollection(workspaceId, runId, 'ready_for_review', 'requested_count_reached',
        'Желаемое количество исходных карточек собрано.', false)
    }
    if (remainingCandidates < 1 || remainingPages < 1) throw new Error('Достигнут общий технический предел пакета (5000 карточек или 200 страниц). Проверьте сохранённые результаты или начните новый поиск.')
    if (automatic) {
      const updated = this.store.enableAutomaticCollection(workspaceId, runId)
      this.startWorker(updated, false, () => this.continueRun(workspaceId, runId))
      return this.requireRun(workspaceId, runId)
    }
    let job = this.jobs.get(runId)
    if (job?.canContinue) {
      this.store.startCollection(workspaceId, runId)
      try {
        const snapshot = await this.watchJob(job, () => job!.continue(Math.min(20, remainingPages), Math.min(1000, remainingCandidates)))
        return mapSnapshot(this.store, workspaceId, runId, snapshot)
      } catch (error) { return this.failJob(run, job, error) }
    }
    this.store.startCollection(workspaceId, runId)
    if (job) await job.dispose().catch(() => {})
    const updated = this.requireRun(workspaceId, runId)
    job = this.createJob(updated)
    return this.startJob(updated, job)
  }

  decideCandidates(workspaceId: string, runId: string, candidateIds: string[], decision: ImportCandidate['userDecision']): Promise<void> {
    this.store.decideCandidates(workspaceId, runId, candidateIds, decision)
    return Promise.resolve()
  }
  reviewBranchGroup(workspaceId: string, runId: string, groupKey: string, classification: 'independent' | 'confirmed'): Promise<void> {
    this.store.reviewBranchGroup(workspaceId, runId, groupKey, classification)
    return Promise.resolve()
  }
  editCandidate(workspaceId: string, runId: string, candidateId: string, fields: CandidateFields): Promise<ImportCandidate> {
    return Promise.resolve(this.store.editCandidate(workspaceId, runId, candidateId, fields))
  }
  addCandidate(workspaceId: string, runId: string, fields: CandidateFields): Promise<ImportCandidate> {
    return Promise.resolve(this.store.addCandidate(workspaceId, runId, fields))
  }
  async deleteRun(workspaceId: string, runId: string): Promise<void> {
    this.store.deleteRun(workspaceId, runId)
    const job = this.jobs.get(runId)
    if (job) await job.dispose()
    this.jobs.delete(runId)
  }
  async rejectRun(workspaceId: string, runId: string): Promise<ImportRun> {
    const run = this.store.rejectRun(workspaceId, runId)
    const job = this.jobs.get(runId)
    if (job) await job.dispose()
    this.jobs.delete(runId)
    return run
  }
  preparePublication(workspaceId: string, runId: string): Promise<string> { return Promise.resolve(this.store.preparePublication(workspaceId, runId)) }
  recordPublication(workspaceId: string, runId: string, report: PublicationReport): Promise<ImportRun> {
    return Promise.resolve(this.store.savePublication(workspaceId, runId, report))
  }

  close(): void {
    this.closed = true
    for (const job of this.jobs.values()) void job.dispose()
    this.store.close()
  }

  private requireRun(workspaceId: string, runId: string): ImportRun {
    const run = this.store.getRun(workspaceId, runId)
    if (!run) throw new Error('Локальный пакет не найден для этой команды.')
    return run
  }
}

const recoverableReasons = ['local_process_restarted', 'source_error', 'browser_start_failed', 'browser_closed', 'resume_failed', 'page_layout_changed']

function validateParameters(parameters: ImportRunParameters, createdBy: string): void {
  if (parameters.source !== '2gis') throw new Error('Выбранный источник пока не поддерживается.')
  if (!uuid(parameters.workspaceId) || !uuid(createdBy)) throw new Error('Некорректный ID пользователя или рабочей команды.')
  if (!parameters.city.trim() || parameters.city.length > 200 || !parameters.niche.trim() || parameters.niche.length > 200) {
    throw new Error('Укажите город и нишу длиной не более 200 символов.')
  }
  if (!Number.isSafeInteger(parameters.requestedCount) || parameters.requestedCount < 0 || parameters.requestedCount > 5000) {
    throw new Error('Количество должно быть целым числом от 0 до 5000.')
  }
}

function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }

function mapSnapshot(store: SqliteImportStore, workspaceId: string, runId: string, snapshot: LocalJobSnapshot, sourceComplete = false): ImportRun {
  const run = store.getRun(workspaceId, runId)
  if (!run) throw new Error('Локальный пакет исчез во время сбора.')
  if (snapshot.status === 'collecting' || snapshot.status === 'starting') return run
  const status = snapshot.status === 'ready_for_review' ? 'ready_for_review'
    : snapshot.status === 'cancelled' ? 'cancelled'
      : snapshot.status === 'failed' ? 'failed'
        : snapshot.status === 'needs_attention' ? 'needs_attention' : 'partially_completed'
  const finished = store.finishCollection(workspaceId, runId, status, snapshot.stopReason, snapshot.message, sourceComplete)
  return finished
}
