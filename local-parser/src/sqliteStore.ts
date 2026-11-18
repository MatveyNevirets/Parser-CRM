import initSqlJs, { type Database as SqlDatabase } from 'sql.js'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { classifyCompanies } from '../../src/imports/classify.ts'
import { normalizeCompanyCard } from '../../src/imports/normalize.ts'
import { transitionImportRun } from '../../src/imports/stateMachine.ts'
import { hasCandidateWebsite, isReviewableImportRun, isEligibleForReview } from '../../src/imports/review.ts'
import { hasCurrentNoWebsiteCheck } from '../../src/imports/websiteEvidence.ts'
import type { ClassifiedCompany, ImportCandidate, ImportRun, ImportRunParameters } from '../../src/imports/types.ts'
import type { CandidateFields, PublicationReport } from '../../src/imports/service.ts'

const activeStatuses = new Set(['created', 'collecting'])
const require = createRequire(import.meta.url)

export function defaultDatabasePath(): string {
  const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(root, 'PahotaCRM', 'imports.sqlite')
}

export class SqliteImportStore {
  private inTransaction = false

  private constructor(private readonly db: SqlDatabase, private readonly path: string) {}

  static async open(path = defaultDatabasePath()): Promise<SqliteImportStore> {
    mkdirSync(dirname(path), { recursive: true })
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm') as string
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    const data = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined
    const db = new SQL.Database(data)
    const store = new SqliteImportStore(db, path)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`
      CREATE TABLE IF NOT EXISTS import_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS import_runs_workspace_created_idx ON import_runs(workspace_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS import_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS import_candidates_run_position_idx ON import_candidates(run_id, position);
      CREATE INDEX IF NOT EXISTS import_candidates_run_name_idx ON import_candidates(run_id, id);
      CREATE TABLE IF NOT EXISTS import_seen_cards (
        run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
        identity TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        PRIMARY KEY (run_id, identity)
      );
    `)
    store.markInterruptedRuns()
    store.refreshUnpublishedWebsiteChecks()
    store.persist()
    return store
  }

  createRun(parameters: ImportRunParameters, createdBy: string, automaticCollection = false): ImportRun {
    const now = new Date().toISOString()
    const run: ImportRun = {
      ...parameters, excludeWithWebsite: parameters.excludeWithWebsite ?? true, id: randomUUID(), createdBy, automaticCollection, status: 'created', publicationStatus: 'not_started', completeness: 'unknown',
      startedAt: null, finishedAt: null, rawFound: 0, storedCount: 0, uniqueCount: 0, exactDuplicateCount: 0,
      possibleDuplicateCount: 0, branchGroupCount: 0, invalidCount: 0, needsReviewCount: 0, existingCount: 0,
      readyCount: 0, importedCount: 0, publicationIdempotencyKey: null, sourceCursor: null, currentPage: 0, classifiedPage: 0,
      excludedCount: 0, stopReason: null, errorMessage: null,
    }
    this.execute('INSERT INTO import_runs(id, workspace_id, created_at, payload) VALUES (?, ?, ?, ?)',
      [run.id, run.workspaceId, now, JSON.stringify(run)])
    return run
  }

  listRuns(workspaceId: string, limit = 25): ImportRun[] {
    return this.query<{ payload: string }>('SELECT payload FROM import_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
      [workspaceId, Math.max(1, Math.min(100, limit))]).map((row) => parseRun(row.payload))
  }

  getInterruptedAutomaticRuns(): ImportRun[] {
    return this.query<{ payload: string }>('SELECT payload FROM import_runs').map((row) => parseRun(row.payload))
      .filter((run) => run.automaticCollection && run.status === 'needs_attention' && run.stopReason === 'local_process_restarted')
  }

  enableAutomaticCollection(workspaceId: string, runId: string): ImportRun {
    return this.saveRun({ ...this.requireRun(workspaceId, runId), automaticCollection: true })
  }

  getRun(workspaceId: string, runId: string): ImportRun | null {
    const row = this.query<{ payload: string }>('SELECT payload FROM import_runs WHERE workspace_id = ? AND id = ?', [workspaceId, runId])[0]
    return row ? parseRun(row.payload) : null
  }

  getCandidates(runId: string): ImportCandidate[] {
    return this.query<{ payload: string }>('SELECT payload FROM import_candidates WHERE run_id = ? ORDER BY position', [runId])
      .map((row) => parseCandidate(row.payload))
  }

  getSeenSourceCardIds(runId: string): string[] {
    return this.query<{ identity: string }>('SELECT identity FROM import_seen_cards WHERE run_id = ?', [runId])
      .map((row) => row.identity.match(/^2gis:id:(.+)$/)?.[1]).filter((id): id is string => Boolean(id))
  }

  listCandidates(workspaceId: string, runId: string, page: number, pageSize: number, search = ''): { items: ImportCandidate[]; total: number } {
    this.assertRun(workspaceId, runId)
    const needle = search.trim().toLocaleLowerCase('ru-RU').slice(0, 100)
    const rows = this.getCandidates(runId)
    const filtered = needle ? rows.filter((candidate) => [candidate.companyName, candidate.city, candidate.address, candidate.phone, candidate.website]
      .some((value) => value?.toLocaleLowerCase('ru-RU').includes(needle))) : rows
    const size = Math.max(1, Math.min(100, pageSize))
    const pageNumber = Math.max(0, page)
    return { items: filtered.slice(pageNumber * size, (pageNumber + 1) * size), total: filtered.length }
  }

  startCollection(workspaceId: string, runId: string): ImportRun {
    const run = this.requireRun(workspaceId, runId)
    if (run.status !== 'created' && run.status !== 'needs_attention' && run.status !== 'partially_completed') {
      throw new Error('Этот пакет нельзя запустить в текущем состоянии.')
    }
    const next = transitionImportRun(run.status, 'collecting')
    return this.saveRun({ ...run, status: next, startedAt: run.startedAt ?? new Date().toISOString(), finishedAt: null,
      stopReason: null, errorMessage: null, completeness: run.completeness === 'partial' ? 'partial' : 'unknown' })
  }

  appendPage(workspaceId: string, runId: string, pageIndex: number, rawCount: number, classified: ClassifiedCompany[], sourceComplete: boolean, advancePage = true): ImportRun {
    const run = this.requireRun(workspaceId, runId)
    if (!activeStatuses.has(run.status) || run.status !== 'collecting') throw new Error('Сбор этого пакета сейчас не выполняется.')
    return this.transaction(() => {
      const prior = this.getCandidates(runId)
      // Keep only identities/counts for rejected cards, so a third branch on a later
      // page removes the earlier two and cannot reappear after a restart.
      for (const candidate of [...prior, ...classified]) {
        this.execute('INSERT OR IGNORE INTO import_seen_cards(run_id, identity, normalized_name) VALUES (?, ?, ?)',
          [runId, cardIdentity(candidate), candidate.normalizedName])
      }
      const blockedNames = new Set(this.query<{ normalized_name: string }>(
        'SELECT normalized_name FROM import_seen_cards WHERE run_id = ? GROUP BY normalized_name HAVING COUNT(*) > 2',
        [runId],
      ).map((row) => row.normalized_name))
      const otherCandidates = this.query<{ payload: string }>(
        'SELECT c.payload FROM import_candidates c JOIN import_runs r ON r.id = c.run_id WHERE r.workspace_id = ? AND r.id <> ?',
        [workspaceId, runId],
      ).map((row) => parseCandidate(row.payload)).filter((candidate) =>
        candidate.importStatus === 'imported' || candidate.importStatus === 'skipped_existing'
        || (hasCandidateWebsite(candidate) && (run.excludeWithWebsite !== false || candidate.exclusionReason !== websiteExclusion))
        || hasCurrentNoWebsiteCheck(candidate))
      const kept: ImportCandidate[] = []
      for (const candidate of [...prior, ...classified.map((candidate) => ({
        ...candidate, runId, branchOverride: 'unreviewed' as const, userDecision: 'pending' as const,
        importStatus: 'not_ready' as const, importedLeadId: null, exclusionReason: null,
      }))]) {
        if (blockedNames.has(candidate.normalizedName)) continue
        // Preserve the URL when a later read enriches the same source card.
        const previous = kept.findIndex((other) => cardIdentity(candidate) === cardIdentity(other))
        if (previous >= 0) {
          const existing = kept[previous]
          if (existing.importStatus === 'imported' || existing.importStatus === 'skipped_existing') continue
          if (hasCandidateWebsite(candidate)) kept[previous] = {
            ...existing, website: candidate.website ?? existing.website, normalizedDomain: candidate.normalizedDomain ?? existing.normalizedDomain,
            websiteCheckStatus: 'present',
            websiteCheckVersion: candidate.websiteCheckVersion, websiteCheckedAt: candidate.websiteCheckedAt,
            websiteCheckedSourceUrl: candidate.websiteCheckedSourceUrl,
          }
          else if (!existing.website?.trim() && existing.websiteCheckStatus !== 'present'
            && !hasCurrentNoWebsiteCheck(existing) && hasCurrentNoWebsiteCheck(candidate)) {
            const automaticallyExcluded = existing.userDecision === 'exclude'
              && existing.exclusionReason?.startsWith('Требуется повторная проверка')
            kept[previous] = {
              ...existing, website: null, normalizedDomain: null, websiteCheckStatus: 'absent',
              sourceUrl: candidate.sourceUrl, sourceCardId: candidate.sourceCardId,
              websiteCheckVersion: candidate.websiteCheckVersion, websiteCheckedAt: candidate.websiteCheckedAt,
              websiteCheckedSourceUrl: candidate.websiteCheckedSourceUrl,
              ...(automaticallyExcluded ? { userDecision: 'pending' as const, importStatus: 'not_ready' as const, exclusionReason: null } : {}),
            }
          }
          continue
        }
        if (otherCandidates.some((other) => sameCompany(candidate, other))
          || kept.some((other) => sameCompany(candidate, other))) continue
        kept.push(candidate)
      }
      const reclassified = recalcReadiness(reclassify(kept), run)
      this.execute('DELETE FROM import_candidates WHERE run_id = ?', [runId])
      reclassified.forEach((candidate, position) => this.execute(
        'INSERT OR REPLACE INTO import_candidates(id, run_id, position, payload) VALUES (?, ?, ?, ?)',
        [candidate.candidateId, runId, position, JSON.stringify(candidate)],
      ))
      const currentPage = advancePage ? pageIndex + 1 : pageIndex
      const updated = updateMetrics({ ...run, rawFound: run.rawFound + rawCount, currentPage,
        classifiedPage: currentPage, completeness: sourceComplete ? 'complete' : 'partial' }, reclassified)
      this.saveRun(updated)
      return updated
    })
  }

  finishCollection(workspaceId: string, runId: string, status: ImportRun['status'], reason: string | null, message: string | null, sourceComplete: boolean): ImportRun {
    const run = this.requireRun(workspaceId, runId)
    const finishedAt = ['collecting', 'created'].includes(run.status) || status === 'cancelled'
      ? new Date().toISOString() : run.finishedAt
    if (!['ready_for_review', 'partially_completed', 'needs_attention', 'cancelled', 'failed'].includes(status)) throw new Error('Неизвестный итог сбора.')
    if (run.status === status) return run
    if (status === 'ready_for_review' || status === 'partially_completed' || status === 'needs_attention') {
      if (run.status !== 'collecting') throw new Error('Сбор уже остановлен; состояние нельзя заменить.')
      transitionImportRun(run.status, status)
    } else if (status === 'cancelled' || status === 'failed') {
      const cancellingRecoverable = status === 'cancelled' && run.publicationStatus === 'not_started'
        && ['needs_attention', 'partially_completed'].includes(run.status)
      if (!activeStatuses.has(run.status) && !cancellingRecoverable) throw new Error('Уже остановленный пакет нельзя отменить повторно.')
      transitionImportRun(run.status, status)
    }
    const complete = sourceComplete && status === 'ready_for_review'
    return this.saveRun({ ...run, status, stopReason: reason, errorMessage: message, finishedAt,
      completeness: complete ? 'complete' : run.rawFound ? 'partial' : 'unknown' })
  }

  decideCandidates(workspaceId: string, runId: string, candidateIds: string[], decision: ImportCandidate['userDecision']): void {
    if (candidateIds.length > 100) throw new Error('За один раз можно выбрать не более 100 карточек.')
    const run = this.requireReviewableRun(workspaceId, runId)
    const selected = new Set(candidateIds)
    const updated = this.getCandidates(runId).map((candidate) => selected.has(candidate.candidateId)
      ? { ...candidate, userDecision: decision, exclusionReason: decision === 'exclude' ? 'Исключено пользователем.' : null }
      : candidate)
    if (selected.size !== updated.filter((candidate) => selected.has(candidate.candidateId)).length) throw new Error('В списке есть карточка не из этого пакета.')
    this.saveCandidates(runId, recalcReadiness(updated, run), run)
  }

  reviewBranchGroup(workspaceId: string, runId: string, groupKey: string, classification: 'independent' | 'confirmed'): void {
    const run = this.requireReviewableRun(workspaceId, runId)
    const candidates = this.getCandidates(runId)
    if (!candidates.some((candidate) => candidate.branchGroupKey === groupKey)) throw new Error('Группа филиалов не найдена.')
    const updated = candidates.map((candidate) => {
      if (candidate.branchGroupKey !== groupKey) return candidate
      if (classification === 'independent') return {
        ...candidate, branchClassification: 'independent' as const, branchOverride: 'independent' as const,
        userDecision: candidate.exclusionReason?.startsWith('Подтверждена филиальная группа') ? 'pending' as const : candidate.userDecision,
        exclusionReason: candidate.exclusionReason?.startsWith('Подтверждена филиальная группа') ? null : candidate.exclusionReason,
      }
      return { ...candidate, branchClassification: 'confirmed' as const, branchOverride: 'confirmed' as const,
        userDecision: 'exclude' as const, importStatus: 'not_ready' as const, exclusionReason: `Подтверждена филиальная группа ${groupKey}.` }
    })
    this.saveCandidates(runId, recalcReadiness(updated, run), run)
  }

  addCandidate(workspaceId: string, runId: string, fields: CandidateFields): ImportCandidate {
    const run = this.requireReviewableRun(workspaceId, runId)
    const candidateId = randomUUID()
    const normalized = normalizeCompanyCard({
      ...fields, candidateId, source: run.source, sourceCardId: null, sourceNetworkId: null,
      sourceName: fields.companyName, sourceUrl: null, websiteCheckStatus: fields.website.trim() ? 'present' : 'unknown',
      rating: null, reviewCount: null, latitude: null, longitude: null, receivedAt: new Date().toISOString(),
    })
    if (normalized.validationErrors.length) throw new Error(normalized.validationErrors.join(' '))
    const candidate: ImportCandidate = { ...normalized, runId, branchOverride: 'unreviewed', userDecision: 'pending',
      importStatus: 'not_ready', importedLeadId: null, exclusionReason: null, duplicateOfId: null, duplicateKind: null,
      branchGroupKey: null, branchClassification: 'none', branchEvidence: [] }
    this.saveCandidates(runId, recalcReadiness(reclassify([...this.getCandidates(runId), candidate]), run),
      { ...run, rawFound: run.rawFound + 1 })
    return this.getCandidates(runId).find((item) => item.candidateId === candidateId)!
  }

  editCandidate(workspaceId: string, runId: string, candidateId: string, fields: CandidateFields): ImportCandidate {
    const run = this.requireReviewableRun(workspaceId, runId)
    const candidates = this.getCandidates(runId)
    const prior = candidates.find((candidate) => candidate.candidateId === candidateId)
    if (!prior) throw new Error('Карточка не найдена в этом пакете.')
    const normalized = normalizeCompanyCard({ ...prior, ...fields,
      address: fields.address.trim() || null, phone: fields.phone.trim() || null, website: fields.website.trim() || null,
      candidateId: prior.candidateId, receivedAt: prior.receivedAt })
    if (normalized.website !== prior.website || normalized.companyName !== prior.companyName
      || normalized.city !== prior.city || normalized.address !== prior.address) {
      normalized.websiteCheckStatus = normalized.website ? 'present' : 'unknown'
      normalized.websiteCheckVersion = undefined
      normalized.websiteCheckedAt = undefined
      normalized.websiteCheckedSourceUrl = undefined
    }
    const revised = candidates.map((candidate) => candidate.candidateId === candidateId
      ? { ...candidate, ...normalized, userDecision: 'pending' as const, importStatus: 'not_ready' as const,
        branchOverride: 'unreviewed' as const, branchClassification: 'none' as const,
        branchGroupKey: null, duplicateKind: null, duplicateOfId: null, branchEvidence: [], exclusionReason: null }
      : candidate)
    const reclassified = preserveManualBranchReviews(reclassify(revised), revised)
    this.saveCandidates(runId, recalcReadiness(reclassified, run), run)
    return this.getCandidates(runId).find((candidate) => candidate.candidateId === candidateId)!
  }

  savePublication(workspaceId: string, runId: string, report: PublicationReport): ImportRun {
    const run = this.requireRun(workspaceId, runId)
    if (run.publicationStatus !== 'not_started' && run.publicationIdempotencyKey === null) throw new Error('Публикация этого пакета уже завершена.')
    const items = new Map(report.items.map((item) => [item.candidateId, item]))
    const candidates = this.getCandidates(runId).map((candidate) => {
      const result = items.get(candidate.candidateId)
      if (!result) return candidate
      if (result.status === 'created') return { ...candidate, importStatus: 'imported' as const, importedLeadId: result.leadId }
      if (result.status === 'already_exists') return { ...candidate, importStatus: 'skipped_existing' as const }
      return { ...candidate, importStatus: 'failed' as const, exclusionReason: result.reason ?? 'Не удалось опубликовать эту карточку.' }
    })
    const updated = updateMetrics({ ...run, status: report.status, publicationStatus: report.status,
      existingCount: candidates.filter((candidate) => candidate.importStatus === 'skipped_existing').length,
      importedCount: candidates.filter((candidate) => candidate.importStatus === 'imported').length,
      excludedCount: report.excluded,
      finishedAt: new Date().toISOString() }, candidates)
    this.saveCandidates(runId, candidates, updated)
    return updated
  }

  preparePublication(workspaceId: string, runId: string): string {
    let run = this.requireRun(workspaceId, runId)
    if (run.status === 'collecting') throw new Error('Остановите сбор перед публикацией пакета.')
    if (run.status === 'partially_completed' && run.publicationStatus === 'partially_completed') {
      const candidates = recalcReadiness(this.getCandidates(runId).map((candidate) => candidate.importStatus === 'failed'
        ? { ...candidate, importStatus: 'not_ready' as const, exclusionReason: null } : candidate), run)
      if (!candidates.some((candidate) => candidate.importStatus === 'ready')) throw new Error('В пакете нет неудачных публикаций, которые можно повторить.')
      transitionImportRun(run.status, 'ready_for_review')
      run = { ...run, status: 'ready_for_review', publicationStatus: 'not_started', publicationIdempotencyKey: randomUUID() }
      this.saveCandidates(runId, candidates, run)
      return run.publicationIdempotencyKey!
    }
    if (!isReviewableImportRun(run)) {
      throw new Error('Пакет не готов к подтверждённой публикации.')
    }
    if (!this.getCandidates(runId).some((candidate) => candidate.importStatus === 'ready' && isEligibleForReview(candidate, run.excludeWithWebsite))) {
      throw new Error('В пакете нет карточек, готовых к публикации. Сначала включите подходящие карточки.')
    }
    if (!run.publicationIdempotencyKey) this.saveRun({ ...run, publicationIdempotencyKey: randomUUID() })
    return this.requireRun(workspaceId, runId).publicationIdempotencyKey!
  }

  deleteRun(workspaceId: string, runId: string): void {
    const run = this.requireRun(workspaceId, runId)
    if (!['ready_for_review', 'partially_completed', 'needs_attention', 'cancelled', 'rejected', 'failed'].includes(run.status)
      || run.publicationStatus !== 'not_started') {
      throw new Error('Удалить можно только завершённый локальный пакет до публикации. Сначала остановите активный сбор.')
    }
    this.execute('DELETE FROM import_runs WHERE id = ? AND workspace_id = ?', [runId, workspaceId])
  }

  rejectRun(workspaceId: string, runId: string): ImportRun {
    const run = this.requireReviewableRun(workspaceId, runId)
    return this.saveRun({ ...run, status: 'rejected', publicationStatus: 'rejected', finishedAt: new Date().toISOString(),
      stopReason: 'user_rejected', errorMessage: 'Пакет отклонён пользователем; лиды не создавались.' })
  }

  close(): void { this.persist(); this.db.close() }

  private markInterruptedRuns(): void {
    const rows = this.query<{ id: string; payload: string }>('SELECT id, payload FROM import_runs')
      .filter((row) => {
        const run = parseRun(row.payload)
        return run.status === 'collecting' || (run.status === 'needs_attention' && run.stopReason === 'captcha_manual')
      })
    this.transaction(() => rows.forEach((row) => {
      const run = parseRun(row.payload)
      this.execute('UPDATE import_runs SET payload = ? WHERE id = ?', [JSON.stringify({ ...run, status: 'needs_attention',
        stopReason: 'local_process_restarted',
        errorMessage: run.stopReason === 'captcha_manual'
          ? 'Локальный процесс перезапустился во время ручной проверки CAPTCHA. Карточки сохранены; продолжение откроет новое окно Chromium.'
          : 'Локальный процесс перезапустился. Сохранённые карточки остались в пакете; сбор можно продолжить в новом окне.' }), row.id])
    }))
  }

  private refreshUnpublishedWebsiteChecks(): void {
    const runs = this.query<{ payload: string }>('SELECT payload FROM import_runs')
      .map((row) => parseRun(row.payload))
      .filter((run) => run.publicationStatus === 'not_started' || run.publicationStatus === 'partially_completed')
    this.transaction(() => {
      for (const run of runs) {
        const previous = this.getCandidates(run.id)
        const terminal = new Map(previous.filter((candidate) => candidate.importStatus === 'imported'
          || candidate.importStatus === 'skipped_existing').map((candidate) => [candidate.candidateId, candidate]))
        const refreshed = recalcReadiness(reclassify(previous), run).map((candidate) => terminal.get(candidate.candidateId) ?? candidate)
        if (JSON.stringify(refreshed) !== JSON.stringify(previous)
          || JSON.stringify(updateMetrics(run, refreshed)) !== JSON.stringify(run)) this.saveCandidates(run.id, refreshed, run)
      }
    })
  }

  private assertRun(workspaceId: string, runId: string): void { this.requireRun(workspaceId, runId) }
  private requireRun(workspaceId: string, runId: string): ImportRun {
    const run = this.getRun(workspaceId, runId)
    if (!run) throw new Error('Локальный пакет не найден для этой команды.')
    return run
  }
  private requireReviewableRun(workspaceId: string, runId: string): ImportRun {
    const run = this.requireRun(workspaceId, runId)
    if (!isReviewableImportRun(run)) {
      throw new Error('Этот пакет нельзя редактировать в текущем состоянии.')
    }
    return run
  }
  private saveRun(run: ImportRun): ImportRun {
    const changed = this.execute('UPDATE import_runs SET payload = ? WHERE id = ? AND workspace_id = ?',
      [JSON.stringify(run), run.id, run.workspaceId])
    if (!changed) throw new Error('Локальный пакет не найден.')
    if (!this.inTransaction) this.persist()
    return run
  }
  private saveCandidates(runId: string, candidates: ImportCandidate[], run: ImportRun): void {
    this.transaction(() => {
      this.execute('DELETE FROM import_candidates WHERE run_id = ?', [runId])
      candidates.forEach((candidate, index) => this.execute(
        'INSERT INTO import_candidates(id, run_id, position, payload) VALUES (?, ?, ?, ?)',
        [candidate.candidateId, runId, index, JSON.stringify(candidate)],
      ))
      this.saveRun(updateMetrics(run, candidates))
    })
  }
  private transaction<T>(action: () => T): T {
    if (this.inTransaction) return action()
    this.db.run('BEGIN IMMEDIATE')
    this.inTransaction = true
    let result: T
    try {
      result = action()
      this.db.run('COMMIT')
      this.inTransaction = false
    } catch (error) {
      this.inTransaction = false
      this.db.run('ROLLBACK')
      throw error
    }
    this.persist()
    return result
  }
  private query<T>(sql: string, params: Array<string | number | null> = []): T[] {
    const statement = this.db.prepare(sql)
    try {
      if (params.length) statement.bind(params)
      const rows: T[] = []
      while (statement.step()) rows.push(statement.getAsObject() as T)
      return rows
    } finally { statement.free() }
  }
  private execute(sql: string, params: Array<string | number | null> = []): boolean {
    const statement = this.db.prepare(sql)
    try { if (params.length) statement.bind(params); statement.step(); return this.db.getRowsModified() > 0 }
    finally { statement.free() }
  }
  private persist(): void {
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    try {
      const snapshot = this.db.export()
      // sql.js reopens its in-memory database during export; restore connection-local pragmas.
      this.db.exec('PRAGMA foreign_keys = ON')
      writeFileSync(temporaryPath, Buffer.from(snapshot))
      renameSync(temporaryPath, this.path)
    } catch (error) {
      try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath) } catch { /* preserve the persistence error */ }
      throw error
    }
  }
}

function reclassify(candidates: ImportCandidate[]): ImportCandidate[] {
  const classified = classifyCompanies(candidates.map(({ runId: _runId, branchOverride: _branchOverride, userDecision: _decision,
    importStatus: _status, importedLeadId: _lead, exclusionReason: _reason, ...candidate }) => candidate))
  return preserveManualBranchReviews(classified, candidates.map((candidate) => candidate))
}

function preserveManualBranchReviews(classified: ClassifiedCompany[], previous: ImportCandidate[]): ImportCandidate[] {
  const old = new Map(previous.map((candidate) => [candidate.candidateId, candidate]))
  return classified.map((candidate) => {
    const prior = old.get(candidate.candidateId)
    const branch = prior?.branchOverride === 'independent'
      ? { branchClassification: 'independent' as const, branchOverride: 'independent' as const, branchGroupKey: null, branchEvidence: [] }
      : prior?.branchOverride === 'confirmed'
        ? { branchClassification: 'confirmed' as const, branchOverride: 'confirmed' as const, branchGroupKey: prior.branchGroupKey, branchEvidence: prior.branchEvidence }
        : { branchClassification: candidate.branchClassification, branchOverride: 'unreviewed' as const, branchGroupKey: candidate.branchGroupKey, branchEvidence: candidate.branchEvidence }
    return { ...candidate, runId: prior?.runId ?? '', ...branch,
      userDecision: prior?.userDecision ?? 'pending', importStatus: prior?.importStatus ?? 'not_ready',
      importedLeadId: prior?.importedLeadId ?? null, exclusionReason: prior?.exclusionReason ?? null }
  })
}

const websiteExclusion = 'Найден сайт. Карточка исключена из публикации в CRM.'

function recalcReadiness(candidates: ImportCandidate[], run: ImportRun): ImportCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.importStatus === 'imported' || candidate.importStatus === 'skipped_existing') return candidate
    if (run.excludeWithWebsite !== false && hasCandidateWebsite(candidate)) return {
      ...candidate, userDecision: 'exclude', importStatus: 'not_ready',
      exclusionReason: websiteExclusion,
    }
    // Restore drafts automatically excluded by older versions for an incomplete check.
    if (candidate.userDecision === 'exclude' && (candidate.exclusionReason?.startsWith('Требуется повторная проверка')
      || candidate.exclusionReason?.startsWith('Не удалось подтвердить отсутствие сайта'))) {
      candidate = { ...candidate, userDecision: 'pending', exclusionReason: null }
    }
    const ready = candidate.userDecision === 'include' && isEligibleForReview(candidate, run.excludeWithWebsite)
    return { ...candidate, importStatus: ready ? 'ready' : 'not_ready' }
  })
}

function updateMetrics(run: ImportRun, candidates: ImportCandidate[]): ImportRun {
  return {
    ...run,
    storedCount: candidates.length,
    uniqueCount: candidates.filter((candidate) => candidate.duplicateKind === null).length,
    exactDuplicateCount: candidates.filter((candidate) => candidate.duplicateKind === 'exact').length,
    possibleDuplicateCount: candidates.filter((candidate) => candidate.duplicateKind === 'possible').length,
    branchGroupCount: new Set(candidates.map((candidate) => candidate.branchGroupKey).filter(Boolean)).size,
    invalidCount: candidates.filter((candidate) => candidate.validationErrors.length > 0).length,
    needsReviewCount: candidates.filter((candidate) => candidate.branchClassification === 'needs_review' && candidate.branchOverride === 'unreviewed').length,
    readyCount: candidates.filter((candidate) => candidate.importStatus === 'ready').length,
    excludedCount: Math.max(0, run.rawFound - candidates.length) + candidates.filter((candidate) => candidate.userDecision === 'exclude').length,
  }
}

function parseRun(value: string): ImportRun { return JSON.parse(value) as ImportRun }
function parseCandidate(value: string): ImportCandidate { return JSON.parse(value) as ImportCandidate }

function cardIdentity(candidate: ClassifiedCompany | ImportCandidate): string {
  return candidate.dedupeKey ?? (candidate.normalizedPhone
    ? `phone:${candidate.normalizedName}:${candidate.normalizedCity}:${candidate.normalizedAddress ?? ''}:${candidate.normalizedPhone}`
    : `address:${candidate.normalizedName}:${candidate.normalizedCity}:${candidate.normalizedAddress ?? ''}`)
}

function sameCompany(left: ImportCandidate, right: ImportCandidate): boolean {
  if (left.candidateId === right.candidateId || (left.dedupeKey && left.dedupeKey === right.dedupeKey)) return true
  if (left.source === right.source && left.sourceUrl && left.sourceUrl === right.sourceUrl) return true
  if (!left.normalizedName || left.normalizedName !== right.normalizedName) return false
  const sameCity = left.normalizedCity === right.normalizedCity
  const sameAddress = left.normalizedAddress && left.normalizedAddress === right.normalizedAddress
  if (sameCity && sameAddress) return true
  const distinctSourceIds = left.source === right.source && left.sourceCardId && right.sourceCardId
  return Boolean(!distinctSourceIds && sameCity && (!left.normalizedAddress || !right.normalizedAddress)
    && left.normalizedPhone && left.normalizedPhone === right.normalizedPhone)
}
