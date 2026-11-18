import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { classifyCompanies } from '../../src/imports/classify.ts'
import { normalizeSourceCompanyCard } from '../../src/imports/normalize.ts'
import { SqliteImportStore } from '../src/sqliteStore.ts'
import { LocalImportService } from '../src/importService.ts'
import type { LocalJobSnapshot, LocalResultPage } from '../src/contracts.ts'

function verifiedCard(id: string, overrides: Partial<Parameters<typeof normalizeSourceCompanyCard>[1]> = {}) {
  return normalizeSourceCompanyCard('2gis', {
    sourceCardId: id, sourceNetworkId: null, sourceName: 'Ромашка', companyName: 'Ромашка', city: 'Казань',
    address: `ул. Ленина, ${id}`, niche: 'Кафе', phone: null, website: null, websiteCheckStatus: 'absent',
    websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(), websiteCheckedSourceUrl: `https://2gis.ru/kazan/firm/${id}`,
    sourceUrl: `https://2gis.ru/kazan/firm/${id}`, rating: null, reviewCount: null, latitude: null, longitude: null,
    ...overrides,
  })
}

test('automatic collection saves partial pages, recovers a failed browser and keeps manual decisions', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-auto-recovery-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  let releaseStart = () => {}
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
  let sessions = 0
  const requests: Array<{ knownCardIds?: string[]; startPage?: number }> = []
  const service = new LocalImportService(store, { createSession(request, onCard) {
    requests.push(request)
    const session = ++sessions
    let acknowledged = false
    let status: LocalJobSnapshot['status'] = 'collecting'
    const card = verifiedCard(String(700 + session), { companyName: `Auto ${session}`, websiteCheckStatus: 'unknown' })
    const snapshot = (): LocalJobSnapshot => ({ runId: request.runId, jobId: String(session), status,
      pageIndex: acknowledged ? 1 : 0, rawFound: acknowledged ? 1 : 0, message: null,
      stopReason: status === 'ready_for_review' ? 'requested_count_reached' : null, canContinue: false })
    return {
      runId: request.runId, canContinue: false, snapshot,
      async start() {
        onCard?.(card)
        if (session === 1) await startGate
        return snapshot()
      },
      async nextPage(): Promise<LocalResultPage | null> {
        if (acknowledged) throw new Error('Fixture browser disconnected')
        return { pageId: String(session), pageIndex: 0, cards: [card], hasMore: true, sourceComplete: false,
          reportedTotal: null, limitations: [], stopReason: null }
      },
      acknowledge() { acknowledged = true; if (session === 2) status = 'ready_for_review'; return snapshot() },
      async continue() { return snapshot() },
      async cancel() { status = 'cancelled'; releaseStart(); return snapshot() },
      async dispose() {},
    }
  } })
  try {
    const workspaceId = randomUUID()
    const run = await service.startRun({ workspaceId, source: '2gis', city: 'Kazan', niche: 'Cafe', requestedCount: 2 }, randomUUID(), true)
    assert.equal(run.status, 'collecting')
    assert.equal((await service.getRun(workspaceId, run.id))?.storedCount, 1, 'The first card is visible while its page is still being processed')
    assert.equal((await service.getRun(workspaceId, run.id))?.currentPage, 0)
    const first = (await service.listCandidates(workspaceId, run.id, 0, 100)).items[0]
    assert.equal(first.userDecision, 'pending')
    await service.decideCandidates(workspaceId, run.id, [first.candidateId], 'include')
    assert.equal((await service.getRun(workspaceId, run.id))?.readyCount, 1)
    await assert.rejects(async () => service.collectNextPage(randomUUID(), run.id), /не найден/)
    await assert.rejects(async () => service.preparePublication(workspaceId, run.id), /Остановите сбор/)
    releaseStart()
    const deadline = Date.now() + 5_000
    while ((await service.getRun(workspaceId, run.id))?.status !== 'ready_for_review' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const completed = await service.getRun(workspaceId, run.id)
    assert.equal(completed?.status, 'ready_for_review')
    assert.equal(completed?.rawFound, 2, 'Progress callbacks and completed pages count each card once')
    assert.equal(completed?.storedCount, 2)
    assert.equal(sessions, 2)
    assert.deepEqual(requests[1].knownCardIds, ['701'])
    assert.equal(requests[1].startPage, 2)
    const saved = (await service.listCandidates(workspaceId, run.id, 0, 100)).items
    assert.equal(saved[0].candidateId, first.candidateId)
    assert.equal(saved[0].userDecision, 'include')
    assert.equal(saved[1].userDecision, 'pending')
  } finally { releaseStart(); service.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('manual cards can be added during collection, edited and included, while discovered sites are excluded', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-manual-card-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Kazan', niche: 'Cafe', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const fields = { companyName: 'Manual company', city: run.city, niche: run.niche, address: '', phone: '', website: '' }
    const added = store.addCandidate(workspaceId, run.id, fields)
    assert.equal(added.websiteCheckStatus, 'unknown')
    assert.equal(added.userDecision, 'pending')
    assert.equal(added.sourceCardId, null)
    store.decideCandidates(workspaceId, run.id, [added.candidateId], 'include')
    assert.equal(store.getRun(workspaceId, run.id)?.readyCount, 1)
    store.editCandidate(workspaceId, run.id, added.candidateId, { ...fields, companyName: 'Updated company' })
    assert.equal(store.getCandidates(run.id)[0].companyName, 'Updated company')
    const excluded = store.addCandidate(workspaceId, run.id, { ...fields, companyName: 'With site', website: 'https://company.example' })
    assert.equal(excluded.userDecision, 'exclude')
    assert.equal(store.getRun(workspaceId, run.id)?.storedCount, 2)
    assert.equal(store.getRun(workspaceId, run.id)?.excludedCount, 1)
    assert.throws(() => store.addCandidate(randomUUID(), run.id, fields), /не найден/)
    assert.throws(() => store.addCandidate(workspaceId, run.id, { ...fields, companyName: '' }), /Название/)
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('cancelling an automatic job preserves partial results and prevents a late page from restarting it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-auto-cancel-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let sessions = 0
  const service = new LocalImportService(store, { createSession(request, onCard) {
    sessions += 1
    const snapshot = (): LocalJobSnapshot => ({ runId: request.runId, jobId: 'cancel', status: 'collecting', pageIndex: 0,
      rawFound: 0, message: null, stopReason: null, canContinue: false })
    return {
      runId: request.runId, canContinue: false, snapshot,
      async start() { onCard?.(verifiedCard('901')); await gate; return snapshot() },
      async nextPage() { throw new Error('A cancelled start must never collect another page') },
      acknowledge: snapshot, continue: async () => snapshot(), cancel: async () => { release(); return snapshot() },
      async dispose() { release() },
    }
  } })
  try {
    const workspaceId = randomUUID()
    const run = await service.startRun({ workspaceId, source: '2gis', city: 'Kazan', niche: 'Cafe', requestedCount: 10 }, randomUUID(), true)
    const cancelled = await service.cancelRun(workspaceId, run.id)
    assert.equal(cancelled.status, 'cancelled')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await service.getRun(workspaceId, run.id))?.status, 'cancelled')
    assert.equal((await service.getRun(workspaceId, run.id))?.storedCount, 1)
    assert.equal(sessions, 1)
  } finally { release(); service.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('reopening SQLite identifies only interrupted automatic runs for resumption', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-auto-restart-'))
  const path = join(folder, 'imports.sqlite')
  let store = await SqliteImportStore.open(path)
  try {
    const workspaceId = randomUUID()
    const automatic = store.createRun({ workspaceId, source: '2gis', city: 'Kazan', niche: 'Cafe', requestedCount: 0 }, randomUUID(), true)
    const manual = store.createRun({ workspaceId, source: '2gis', city: 'Kazan', niche: 'Cafe', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, automatic.id)
    store.startCollection(workspaceId, manual.id)
    store.close()
    store = await SqliteImportStore.open(path)
    assert.deepEqual(store.getInterruptedAutomaticRuns().map((run) => run.id), [automatic.id])
    assert.equal(store.getRun(workspaceId, manual.id)?.stopReason, 'local_process_restarted')
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('stopping collection keeps saved cards reviewable and publishable after restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-stopped-review-'))
  const path = join(folder, 'imports.sqlite')
  let store = await SqliteImportStore.open(path)
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const cards = [verifiedCard('1'), verifiedCard('2', { companyName: 'Есть сайт', website: 'https://company.example', websiteCheckStatus: 'present' }),
      verifiedCard('3', { companyName: 'Не проверена', websiteCheckStatus: 'unknown' })]
    store.appendPage(workspaceId, run.id, 0, 3, classifyCompanies(cards), false)
    store.finishCollection(workspaceId, run.id, 'cancelled', 'user_cancelled', null, false)
    store.close()
    store = await SqliteImportStore.open(path)
    assert.equal(store.getRun(workspaceId, run.id)?.status, 'cancelled')
    assert.throws(() => store.preparePublication(workspaceId, run.id), /нет карточек, готовых/)
    store.decideCandidates(workspaceId, run.id, cards.map((c) => c.candidateId), 'include')
    assert.equal(store.getRun(workspaceId, run.id)?.readyCount, 2)
    assert.deepEqual(store.getCandidates(run.id).filter((c) => c.importStatus === 'ready').map((c) => c.candidateId), [cards[0].candidateId, cards[2].candidateId])
    const key = store.preparePublication(workspaceId, run.id)
    assert.equal(store.preparePublication(workspaceId, run.id), key)
    assert.equal(store.rejectRun(workspaceId, run.id).status, 'rejected')
    assert.throws(() => store.decideCandidates(workspaceId, run.id, [cards[0].candidateId], 'include'), /нельзя редактировать/)
    assert.throws(() => store.preparePublication(workspaceId, run.id), /не готов/)
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('legacy empty-site cards remain publishable on restart while imported rows stay imported', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-proof-upgrade-'))
  const path = join(folder, 'imports.sqlite')
  let store = await SqliteImportStore.open(path)
  let storeOpen = true
  try {
    const workspaceId = randomUUID()
    const makeRun = (id: string) => {
      const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
      const candidate = verifiedCard(id, { companyName: `Компания ${id}` })
      store.startCollection(workspaceId, run.id)
      store.appendPage(workspaceId, run.id, 0, 1, classifyCompanies([candidate]), false)
      store.finishCollection(workspaceId, run.id, 'ready_for_review', null, null, false)
      store.decideCandidates(workspaceId, run.id, [candidate.candidateId], 'include')
      return { run, candidate }
    }
    const draft = makeRun('101')
    const imported = makeRun('102')
    store.savePublication(workspaceId, imported.run.id, { created: 1, alreadyExists: 0, excluded: 0, failed: 0, status: 'completed',
      items: [{ candidateId: imported.candidate.candidateId, leadId: randomUUID(), status: 'created' }] })
    store.close()
    storeOpen = false
    // Recreate a database written by the old parser, before versioned proof existed.
    const require = createRequire(import.meta.url)
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
    const db = new SQL.Database(readFileSync(path))
    for (const entry of [draft, imported]) {
      const result = db.exec(`SELECT payload FROM import_candidates WHERE id = '${entry.candidate.candidateId}'`)[0]
      const legacy = JSON.parse(String(result.values[0][0]))
      delete legacy.websiteCheckVersion
      delete legacy.websiteCheckedAt
      delete legacy.websiteCheckedSourceUrl
      db.run('UPDATE import_candidates SET payload = ? WHERE id = ?', [JSON.stringify(legacy), entry.candidate.candidateId])
    }
    writeFileSync(path, Buffer.from(db.export()))
    db.close()
    store = await SqliteImportStore.open(path)
    storeOpen = true
    const invalidated = store.getCandidates(draft.run.id)[0]
    assert.equal(invalidated.importStatus, 'ready')
    assert.equal(invalidated.userDecision, 'include')
    assert.equal(invalidated.exclusionReason, null)
    assert.equal(store.getRun(workspaceId, draft.run.id)?.readyCount, 1)
    assert.ok(store.preparePublication(workspaceId, draft.run.id))
    assert.equal(store.getCandidates(imported.run.id)[0].importStatus, 'imported')
    assert.equal(store.getRun(workspaceId, imported.run.id)?.importedCount, 1)
  } finally { if (storeOpen) store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('found sites stay excluded while unchecked cards can become ready', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-no-site-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const cards = [verifiedCard('1', { companyName: 'Без сайта' }),
      verifiedCard('2', { companyName: 'С сайтом', website: 'https://example.org', websiteCheckStatus: 'present' }),
      verifiedCard('3', { companyName: 'Неизвестно', websiteCheckStatus: 'unknown' }),
      verifiedCard('4', { companyName: 'Старая карточка', websiteCheckStatus: undefined }),
      verifiedCard('5', { companyName: 'Противоречие', website: 'https://example.org' }),
      verifiedCard('6', { companyName: 'Старая проверка', websiteCheckVersion: undefined }),
      verifiedCard('7', { companyName: 'Другая версия', websiteCheckVersion: 1 }),
      verifiedCard('8', { companyName: 'Другая карточка', websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/99' })]
    store.appendPage(workspaceId, run.id, 0, cards.length, classifyCompanies(cards), false)
    assert.deepEqual(store.getCandidates(run.id).map((c) => c.companyName), cards.map((c) => c.companyName))
    assert.equal(store.getCandidates(run.id)[1].website, 'https://example.org')
    assert.equal(store.getCandidates(run.id).filter((c) => c.userDecision === 'exclude').length, 2)
    assert.equal(store.getRun(workspaceId, run.id)?.rawFound, cards.length)
    assert.equal(store.getRun(workspaceId, run.id)?.storedCount, cards.length)
    store.finishCollection(workspaceId, run.id, 'ready_for_review', null, null, false)
    store.decideCandidates(workspaceId, run.id, cards.map((c) => c.candidateId), 'include')
    assert.deepEqual(store.getCandidates(run.id).filter((c) => c.importStatus === 'ready').map((c) => c.candidateId),
      cards.filter((c) => !c.website).map((c) => c.candidateId))
    assert.equal(store.listCandidates(workspaceId, run.id, 0, 40, 'example.org').total, 2)
    const edited = store.editCandidate(workspaceId, run.id, cards[0].candidateId, {
      companyName: cards[0].companyName, city: 'Казань', address: cards[0].address!, niche: 'Кафе', phone: '', website: 'https://example.org',
    })
    store.decideCandidates(workspaceId, run.id, [edited.candidateId], 'include')
    assert.equal(store.getCandidates(run.id)[0].importStatus, 'not_ready')
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('third distinct card removes the whole name group across pages and restart, even if it has a site', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-name-limit-'))
  const path = join(folder, 'imports.sqlite')
  let store = await SqliteImportStore.open(path)
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const first = verifiedCard('1', { companyName: '«ООО Ромашка»' })
    store.appendPage(workspaceId, run.id, 0, 2, classifyCompanies([first, verifiedCard('2')]), false)
    assert.equal(store.getCandidates(run.id).length, 2)
    store.appendPage(workspaceId, run.id, 1, 1, classifyCompanies([verifiedCard('1')]), false)
    assert.equal(store.getCandidates(run.id).length, 2, 're-reading the same source ID does not count as a branch')
    store.close()
    store = await SqliteImportStore.open(path)
    store.startCollection(workspaceId, run.id)
    store.appendPage(workspaceId, run.id, 2, 1, classifyCompanies([verifiedCard('3', {
      companyName: 'РОМАШКА', website: 'https://example.org', websiteCheckStatus: 'present',
    })]), false)
    assert.equal(store.getCandidates(run.id).length, 0)
    store.appendPage(workspaceId, run.id, 3, 2, classifyCompanies([verifiedCard('4'), verifiedCard('5', { companyName: 'Другая' })]), false)
    assert.deepEqual(store.getCandidates(run.id).map((c) => c.companyName), ['Другая'])
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('a later website enriches the same card without duplicating it and survives restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-site-result-'))
  const path = join(folder, 'imports.sqlite')
  let store = await SqliteImportStore.open(path)
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const first = verifiedCard('123')
    store.appendPage(workspaceId, run.id, 0, 1, classifyCompanies([first]), false)
    store.appendPage(workspaceId, run.id, 1, 1, classifyCompanies([verifiedCard('123', {
      website: 'https://company.example/contacts', websiteCheckStatus: 'present',
    })]), false)
    let results = store.getCandidates(run.id)
    assert.equal(results.length, 1)
    assert.equal(results[0].candidateId, first.candidateId)
    assert.equal(results[0].website, 'https://company.example/contacts')
    assert.equal(results[0].userDecision, 'exclude')
    store.close()
    store = await SqliteImportStore.open(path)
    results = store.getCandidates(run.id)
    assert.equal(results[0].website, 'https://company.example/contacts')
    assert.equal(results[0].importStatus, 'not_ready')
    assert.match(results[0].exclusionReason!, /Найден сайт/)
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('duplicates are skipped within a page, across pages and runs, scoped to the workspace', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-local-dedup-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  try {
    const workspaceId = randomUUID()
    const create = (workspace = workspaceId) => {
      const run = store.createRun({ workspaceId: workspace, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
      store.startCollection(workspace, run.id)
      return run
    }
    const first = create()
    store.appendPage(workspaceId, first.id, 0, 2, classifyCompanies([verifiedCard('1'), verifiedCard('1')]), false)
    assert.equal(store.getCandidates(first.id).length, 1)
    store.appendPage(workspaceId, first.id, 1, 1, classifyCompanies([verifiedCard('1')]), false)
    assert.equal(store.getCandidates(first.id).length, 1)
    const second = create()
    store.appendPage(workspaceId, second.id, 0, 1, classifyCompanies([verifiedCard('9', { address: 'ул. Ленина, 1', niche: 'Рестораны' })]), false)
    assert.equal(store.getCandidates(second.id).length, 0, 'same name and address is still existing after a niche change')
    const other = create(randomUUID())
    store.appendPage(other.workspaceId, other.id, 0, 1, classifyCompanies([verifiedCard('1')]), false)
    assert.equal(store.getCandidates(other.id).length, 1)
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('an obsolete nonterminal draft does not hide a fresh verified card in a new run', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-fresh-after-legacy-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  try {
    const workspaceId = randomUUID()
    const create = () => {
      const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
      store.startCollection(workspaceId, run.id)
      return run
    }
    const oldRun = create()
    store.appendPage(workspaceId, oldRun.id, 0, 1, classifyCompanies([verifiedCard('201', { websiteCheckVersion: undefined })]), false)
    assert.equal(store.getCandidates(oldRun.id)[0].userDecision, 'pending')
    const freshRun = create()
    const fresh = verifiedCard('201')
    store.appendPage(workspaceId, freshRun.id, 0, 1, classifyCompanies([fresh]), false)
    const result = store.getCandidates(freshRun.id)
    assert.equal(result.length, 1)
    assert.equal(result[0].candidateId, fresh.candidateId)
    assert.equal(result[0].userDecision, 'pending')
    store.finishCollection(workspaceId, freshRun.id, 'ready_for_review', null, null, false)
    store.decideCandidates(workspaceId, freshRun.id, [fresh.candidateId], 'include')
    assert.equal(store.getCandidates(freshRun.id)[0].importStatus, 'ready')
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('imported legacy rows and positive website evidence still block cross-run duplicates', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-conservative-dedup-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  try {
    for (const scenario of ['created', 'already_exists', 'website', 'present'] as const) {
      const workspaceId = randomUUID()
      const create = () => {
        const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
        store.startCollection(workspaceId, run.id)
        return run
      }
      const oldRun = create()
      const old = verifiedCard('301', { websiteCheckVersion: undefined,
        ...(scenario === 'website' ? { website: 'https://company.example', websiteCheckStatus: 'present' as const }
          : scenario === 'present' ? { websiteCheckStatus: 'present' as const } : {}) })
      store.appendPage(workspaceId, oldRun.id, 0, 1, classifyCompanies([old]), false)
      if (scenario === 'created' || scenario === 'already_exists') {
        store.finishCollection(workspaceId, oldRun.id, 'ready_for_review', null, null, false)
        store.savePublication(workspaceId, oldRun.id, {
          created: scenario === 'created' ? 1 : 0, alreadyExists: scenario === 'already_exists' ? 1 : 0,
          excluded: 0, failed: 0, status: 'completed',
          items: [{ candidateId: old.candidateId, leadId: scenario === 'created' ? randomUUID() : null, status: scenario }],
        })
      }
      const freshRun = create()
      store.appendPage(workspaceId, freshRun.id, 0, 1, classifyCompanies([verifiedCard('301')]), false)
      assert.equal(store.getCandidates(freshRun.id).length, 0, scenario)
    }
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('fresh same-card proof replaces an automatic old-check exclusion without auto-including it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-same-card-proof-'))
  const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const old = verifiedCard('401', { websiteCheckVersion: 1, sourceUrl: 'https://2gis.ru/kazan/firm/401/tab/info',
      websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/401/tab/info' })
    store.appendPage(workspaceId, run.id, 0, 1, classifyCompanies([old]), false)
    assert.equal(store.getCandidates(run.id)[0].exclusionReason, null)
    const fresh = verifiedCard('401')
    store.appendPage(workspaceId, run.id, 1, 1, classifyCompanies([fresh]), false)
    const saved = store.getCandidates(run.id)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].candidateId, old.candidateId)
    assert.equal(saved[0].sourceUrl, fresh.sourceUrl)
    assert.equal(saved[0].websiteCheckVersion, fresh.websiteCheckVersion)
    assert.equal(saved[0].websiteCheckedAt, fresh.websiteCheckedAt)
    assert.equal(saved[0].websiteCheckedSourceUrl, fresh.websiteCheckedSourceUrl)
    assert.equal(saved[0].userDecision, 'pending')
    assert.equal(saved[0].importStatus, 'not_ready')
    assert.equal(saved[0].exclusionReason, null)
    assert.equal(store.getRun(workspaceId, run.id)?.readyCount, 0)
    store.finishCollection(workspaceId, run.id, 'ready_for_review', null, null, false)
    store.decideCandidates(workspaceId, run.id, [old.candidateId], 'include')
    assert.equal(store.getCandidates(run.id)[0].importStatus, 'ready')
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('manual exclusion survives old proof, reopening and same-card fresh proof', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-manual-proof-'))
  const path = join(folder, 'imports.sqlite')
  let store = await SqliteImportStore.open(path)
  try {
    const workspaceId = randomUUID()
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, randomUUID())
    store.startCollection(workspaceId, run.id)
    const old = verifiedCard('501', { websiteCheckedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
    store.appendPage(workspaceId, run.id, 0, 1, classifyCompanies([old]), false)
    store.finishCollection(workspaceId, run.id, 'partially_completed', 'page_limit_reached', null, false)
    store.decideCandidates(workspaceId, run.id, [old.candidateId], 'exclude')
    store.close()
    store = await SqliteImportStore.open(path)
    assert.equal(store.getCandidates(run.id)[0].exclusionReason, 'Исключено пользователем.')
    store.startCollection(workspaceId, run.id)
    const fresh = verifiedCard('501')
    store.appendPage(workspaceId, run.id, 1, 1, classifyCompanies([fresh]), false)
    store.close()
    store = await SqliteImportStore.open(path)
    const saved = store.getCandidates(run.id)[0]
    assert.equal(saved.candidateId, old.candidateId)
    assert.equal(saved.websiteCheckedAt, fresh.websiteCheckedAt)
    assert.equal(saved.websiteCheckVersion, 2)
    assert.equal(saved.userDecision, 'exclude')
    assert.equal(saved.importStatus, 'not_ready')
    assert.equal(saved.exclusionReason, 'Исключено пользователем.')
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('SQLite keeps local draft rows after the companion is restarted', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-import-store-'))
  const path = join(folder, 'imports.sqlite')
  const workspaceId = randomUUID()
  const createdBy = randomUUID()
  try {
    const store = await SqliteImportStore.open(path)
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, createdBy)
    store.startCollection(workspaceId, run.id)
    const cards = [normalizeSourceCompanyCard('2gis', {
      sourceCardId: '12345', sourceNetworkId: null, sourceName: 'Тестовое кафе', companyName: 'Тестовое кафе', city: 'Казань',
      address: null, niche: 'Кафе', phone: null, website: null, websiteCheckStatus: 'absent', sourceUrl: 'https://2gis.ru/kazan/firm/12345',
      websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(), websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/12345',
      rating: null, reviewCount: null, latitude: null, longitude: null,
    }, '2026-10-19T00:00:00.000Z', randomUUID())]
    store.appendPage(workspaceId, run.id, 0, cards.length, classifyCompanies(cards), false)
    store.close()

    const reopened = await SqliteImportStore.open(path)
    const restoredRun = reopened.getRun(workspaceId, run.id)
    const restoredCandidates = reopened.getCandidates(run.id)
    assert.equal(restoredRun?.status, 'needs_attention')
    assert.equal(restoredRun?.storedCount, 1)
    assert.equal(restoredRun?.stopReason, 'local_process_restarted')
    assert.equal(restoredCandidates[0]?.companyName, 'Тестовое кафе')
    assert.equal(restoredCandidates[0]?.userDecision, 'pending')
    reopened.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('local candidate decisions stay in local SQLite and never create publication rows', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-import-review-'))
  const path = join(folder, 'imports.sqlite')
  const workspaceId = randomUUID()
  const createdBy = randomUUID()
  try {
    const store = await SqliteImportStore.open(path)
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Тверь', niche: 'Кофейни', requestedCount: 1 }, createdBy)
    store.startCollection(workspaceId, run.id)
    const cards = [normalizeSourceCompanyCard('2gis', {
      sourceCardId: '98765', sourceNetworkId: null, sourceName: 'Кофейня', companyName: 'Кофейня', city: 'Тверь',
      address: null, niche: 'Кофейни', phone: null, website: null, websiteCheckStatus: 'absent', sourceUrl: 'https://2gis.ru/tver/firm/98765',
      websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(), websiteCheckedSourceUrl: 'https://2gis.ru/tver/firm/98765',
      rating: null, reviewCount: null, latitude: null, longitude: null,
    }, '2026-10-19T00:00:00.000Z', randomUUID())]
    store.appendPage(workspaceId, run.id, 0, 1, classifyCompanies(cards), false)
    const candidateId = cards[0].candidateId
    store.finishCollection(workspaceId, run.id, 'ready_for_review', 'requested_count_reached', null, false)
    store.decideCandidates(workspaceId, run.id, [candidateId], 'include')
    const reviewed = store.getCandidates(run.id)[0]
    assert.equal(reviewed.userDecision, 'include')
    assert.equal(reviewed.importStatus, 'ready')
    assert.equal(store.listRuns(workspaceId)[0].publicationStatus, 'not_started')
    store.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('partial publication can retry only failed cards with a new persisted idempotency key', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pahota-import-retry-'))
  const path = join(folder, 'imports.sqlite')
  const workspaceId = randomUUID()
  const createdBy = randomUUID()
  try {
    const store = await SqliteImportStore.open(path)
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Пермь', niche: 'Пекарни', requestedCount: 1 }, createdBy)
    store.startCollection(workspaceId, run.id)
    const cards = [normalizeSourceCompanyCard('2gis', {
      sourceCardId: '55123', sourceNetworkId: null, sourceName: 'Пекарня', companyName: 'Пекарня', city: 'Пермь',
      address: null, niche: 'Пекарни', phone: null, website: null, websiteCheckStatus: 'absent', sourceUrl: 'https://2gis.ru/perm/firm/55123',
      websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(), websiteCheckedSourceUrl: 'https://2gis.ru/perm/firm/55123',
      rating: null, reviewCount: null, latitude: null, longitude: null,
    }, '2026-10-19T00:00:00.000Z', randomUUID())]
    store.appendPage(workspaceId, run.id, 0, 1, classifyCompanies(cards), false)
    const candidateId = cards[0].candidateId
    store.finishCollection(workspaceId, run.id, 'ready_for_review', 'requested_count_reached', null, false)
    store.decideCandidates(workspaceId, run.id, [candidateId], 'include')
    const firstKey = store.preparePublication(workspaceId, run.id)
    store.savePublication(workspaceId, run.id, {
      created: 0, alreadyExists: 0, excluded: 0, failed: 1, status: 'partially_completed',
      items: [{ candidateId, leadId: null, status: 'failed', reason: 'Тестовый частичный сбой.' }],
    })

    const retryKey = store.preparePublication(workspaceId, run.id)
    assert.notEqual(retryKey, firstKey)
    assert.equal(store.getRun(workspaceId, run.id)?.publicationStatus, 'not_started')
    assert.equal(store.getCandidates(run.id)[0]?.importStatus, 'ready')
    store.savePublication(workspaceId, run.id, {
      created: 1, alreadyExists: 0, excluded: 0, failed: 0, status: 'completed',
      items: [{ candidateId, leadId: randomUUID(), status: 'created' }],
    })
    assert.equal(store.getRun(workspaceId, run.id)?.status, 'completed')
    assert.equal(store.getRun(workspaceId, run.id)?.importedCount, 1)
    store.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
