import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteImportStore } from '../local-parser/.test-output/local-parser/src/sqliteStore.js'
import { normalizeSourceCompanyCard } from '../local-parser/.test-output/src/imports/normalize.js'
import { classifyCompanies } from '../local-parser/.test-output/src/imports/classify.js'

test('HTTP API includes stopped draft cards, prepares publication and returns its updated run', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pahota-parser-api-'))
  const workspaceId = randomUUID()
  const userId = randomUUID()
  const token = randomBytes(32).toString('base64url')
  let child
  try {
    const store = await SqliteImportStore.open(join(folder, 'PahotaCRM', 'imports.sqlite'))
    const run = store.createRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, userId)
    const cards = Array.from({ length: 16 }, (_, i) => normalizeSourceCompanyCard('2gis', {
      sourceCardId: String(i + 1), sourceNetworkId: null, companyName: `Компания ${i + 1}`, sourceName: `Компания ${i + 1}`,
      city: 'Казань', niche: 'Кафе', address: null, phone: null, website: i === 14 ? 'https://company.example' : null,
      websiteCheckStatus: i === 14 ? 'present' : i === 15 ? 'unknown' : 'absent',
      websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(), websiteCheckedSourceUrl: `https://2gis.ru/kazan/firm/${i + 1}`,
      sourceUrl: `https://2gis.ru/kazan/firm/${i + 1}`, rating: null, reviewCount: null, latitude: null, longitude: null,
    }))
    store.startCollection(workspaceId, run.id)
    store.appendPage(workspaceId, run.id, 0, cards.length, classifyCompanies(cards), false)
    store.finishCollection(workspaceId, run.id, 'cancelled', 'user_cancelled', null, false)
    store.close()
    child = spawn(process.execPath, ['local-parser/.test-output/local-parser/src/server.js'], {
      cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOCALAPPDATA: folder, PARSER_PORT: '0', PARSER_PAIRING_TOKEN: token,
        PARSER_PRINT_PAIRING_TOKEN: 'false', PARSER_ALLOWED_ORIGINS: 'http://localhost:5173' },
    })
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local API startup timeout')), 15_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Local API exited: ${code}`)) })
      child.stdout.on('data', (data) => {
        const url = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
        if (url) { clearTimeout(timer); resolve(url) }
      })
    })
    const request = async (path, body) => {
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10_000),
        headers: { Origin: 'http://localhost:5173', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const data = await response.json()
      assert.ok([200, 201].includes(response.status), data.error)
      return data
    }
    assert.equal((await request('/v1/health')).protocolVersion, 5)
    const beforeDuplicate = await readFile(join(folder, 'PahotaCRM', 'imports.sqlite'))
    const duplicateFolder = join(folder, 'duplicate')
    const duplicate = spawn(process.execPath, ['local-parser/.test-output/local-parser/src/server.js'], {
      cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOCALAPPDATA: duplicateFolder, PARSER_PORT: new URL(base).port,
        PARSER_PAIRING_TOKEN: token, PARSER_PRINT_PAIRING_TOKEN: 'false' },
    })
    let duplicateOutput = ''
    duplicate.stdout.on('data', (chunk) => { duplicateOutput += chunk.toString() })
    duplicate.stderr.on('data', (chunk) => { duplicateOutput += chunk.toString() })
    const duplicateCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { duplicate.kill(); reject(new Error('Duplicate parser did not exit')) }, 10_000)
      duplicate.once('error', (error) => { clearTimeout(timer); reject(error) })
      duplicate.once('exit', (code) => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(duplicateCode, 0)
    assert.match(duplicateOutput, /уже занят/)
    assert.doesNotMatch(duplicateOutput, /Unhandled|node:events|Error: listen/)
    assert.equal(existsSync(join(duplicateFolder, 'PahotaCRM', 'imports.sqlite')), false)
    assert.deepEqual(await readFile(join(folder, 'PahotaCRM', 'imports.sqlite')), beforeDuplicate)
    const path = `/v1/runs/${run.id}`
    const query = `?workspaceId=${workspaceId}`
    assert.equal((await request(path + query)).run.status, 'cancelled')
    await request(path + '/decision', { workspaceId, candidateIds: cards.map((c) => c.candidateId), decision: 'include' })
    assert.equal((await request(path + query)).run.readyCount, 15)
    const added = await request(path + '/candidates', { workspaceId,
      fields: { companyName: 'Manual company', city: 'Kazan', niche: 'Cafe', address: '', phone: '', website: '' } })
    assert.equal(added.candidate.userDecision, 'pending')
    assert.equal(added.candidate.websiteCheckStatus, 'unknown')
    await request(path + '/decision', { workspaceId, candidateIds: [added.candidate.candidateId], decision: 'include' })
    const key = await request(path + '/publication-key', { workspaceId })
    assert.match(key.idempotencyKey, /^[\da-f-]{36}$/)
    const selected = (await request(path + '/candidates' + query + '&page=0&pageSize=100')).items.filter((c) => c.importStatus === 'ready')
    assert.equal(selected.length, 16)
    // Simulated remote report: this test never calls or writes to the real CRM.
    const report = { created: 16, alreadyExists: 0, failed: 0, excluded: 1, status: 'completed',
      items: selected.map((c) => ({ candidateId: c.candidateId, leadId: randomUUID(), status: 'created' })) }
    const recorded = await request(path + '/publication', { workspaceId, report })
    assert.equal(recorded.run.id, run.id, 'The client expects { run }, not { ok: true }')
    assert.equal(recorded.run.status, 'completed')
    assert.equal(recorded.run.importedCount, 16)
    assert.equal((await request(path + query)).run.publicationStatus, 'completed')
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await stopped
    }
    await rm(folder, { recursive: true, force: true })
  }
})
