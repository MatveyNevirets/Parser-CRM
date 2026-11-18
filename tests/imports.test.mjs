import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const moduleCache = new Map()

async function loadTypeScript(url) {
  const key = url.href
  if (moduleCache.has(key)) return moduleCache.get(key)
  const loading = (async () => {
    const source = await readFile(url, 'utf8')
    let javascript = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    const importPaths = [...javascript.matchAll(/from\s+(['"])([^'"]+)\1/g)]
    for (const [, quote, specifier] of importPaths) {
      const dependencyUrl = specifier.startsWith('.')
        ? (await loadTypeScript(new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url))).url
        : import.meta.resolve(specifier)
      javascript = javascript.replace(`from ${quote}${specifier}${quote}`, `from '${dependencyUrl}'`)
    }
    const data = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    return { module: await import(data), url: data }
  })()
  moduleCache.set(key, loading)
  return loading
}

const importsUrl = new URL('../src/imports/', import.meta.url)
const { module: normalization } = await loadTypeScript(new URL('normalize.ts', importsUrl))
const { module: duplicates } = await loadTypeScript(new URL('deduplicate.ts', importsUrl))
const { module: branches } = await loadTypeScript(new URL('branches.ts', importsUrl))
const { module: classification } = await loadTypeScript(new URL('classify.ts', importsUrl))
const { module: states } = await loadTypeScript(new URL('stateMachine.ts', importsUrl))
const { module: csv } = await loadTypeScript(new URL('csv.ts', importsUrl))
const { module: websites } = await loadTypeScript(new URL('../src/lib/leadWebsite.ts', import.meta.url))
const { module: websiteEvidence } = await loadTypeScript(new URL('websiteEvidence.ts', importsUrl))
const { module: publicationRepository } = await loadTypeScript(new URL('repository.ts', importsUrl))

test('no-site approval requires a fresh current check of the exact 2GIS contacts page', () => {
  const valid = {
    source: '2gis', sourceCardId: '123', sourceUrl: 'https://2gis.ru/kazan/firm/123', website: null,
    websiteCheckStatus: 'absent', websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(),
    websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/123',
  }
  assert.equal(websiteEvidence.hasCurrentNoWebsiteCheck(valid), true)
  for (const overrides of [{ website: 'https://company.example' }, { websiteCheckStatus: 'unknown' },
    { websiteCheckVersion: undefined }, { websiteCheckVersion: 1 }, { websiteCheckedAt: undefined },
    { websiteCheckedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
    { websiteCheckedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
    { source: 'yandex_maps' }, { sourceCardId: '999' },
    { websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/123/tab/info' },
    { websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/999' }]) {
    assert.equal(websiteEvidence.hasCurrentNoWebsiteCheck({ ...valid, ...overrides }), false, JSON.stringify(overrides))
  }
})

test('publication transport rejects a discovered website before calling Supabase', async () => {
  let remoteCalls = 0
  const client = { rpc() { remoteCalls += 1; throw new Error('Unexpected remote call') } }
  const candidate = {
    source: '2gis', sourceCardId: '123', sourceUrl: 'https://2gis.ru/kazan/firm/123', website: null,
    websiteCheckStatus: 'present', websiteCheckVersion: 1, websiteCheckedAt: new Date().toISOString(),
    websiteCheckedSourceUrl: 'https://2gis.ru/kazan/firm/123', validationErrors: [], duplicateKind: null,
    branchClassification: 'none', branchOverride: 'unreviewed', userDecision: 'include', importStatus: 'ready',
  }
  await assert.rejects(() => publicationRepository.previewLocalImportPublication(client, 'workspace', '2gis', [candidate], 0), /найден сайт/i)
  await assert.rejects(() => publicationRepository.publishLocalImportCandidates(client, 'workspace', '2gis', 'key', [candidate], 0), /найден сайт/i)
  assert.equal(remoteCalls, 0)
})

test('website presence accepts existing URL formats and respects manual site classifications', () => {
  for (const website of ['https://example.com', 'http://example.com/path', 'example.com', 'www.example.com', 'https://пример.рф']) {
    assert.equal(websites.hasLeadWebsite({ website, website_status: 'unknown' }), true, website)
  }
  for (const website of [null, undefined, '', '   ', 'not a URL', 'ftp://example.com']) {
    assert.equal(websites.hasLeadWebsite({ website, website_status: 'unknown' }), false, String(website))
  }
  for (const website_status of ['hasWebsite', 'poorWebsite']) {
    assert.equal(websites.hasLeadWebsite({ website: null, website_status }), true)
  }
  // URL evidence takes precedence over a stale manual classification.
  assert.equal(websites.hasLeadWebsite({ website: 'https://example.com', website_status: 'noWebsite' }), true)
})

test('social profiles and link pages are not company websites', () => {
  for (const website of ['https://instagram.com/company', 'https://www.vk.com/company', 't.me/company',
    'https://company.taplink.cc', 'https://taplink.ru/company', 'https://wa.me/123', 'https://facebook.com/company']) {
    assert.equal(websites.hasLeadWebsite({ website, website_status: 'hasWebsite' }), false, website)
  }
  assert.equal(websites.hasLeadWebsite({ website: 'https://notvk.com', website_status: 'unknown' }), true)
})

function card(overrides = {}) {
  return {
    candidateId: 'candidate-1',
    source: 'test_source',
    sourceCardId: 'source-1',
    sourceNetworkId: null,
    sourceName: 'ООО Ромашка',
    companyName: 'ООО Ромашка',
    city: 'Казань',
    address: 'ул. Ленина, 1',
    niche: 'Кафе',
    phone: null,
    website: null,
    sourceUrl: 'https://maps.example.test/org/1',
    rating: null,
    reviewCount: null,
    latitude: null,
    longitude: null,
    receivedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  }
}

function normalized(overrides = {}) {
  return normalization.normalizeCompanyCard(card(overrides))
}

test('normalizes incomplete cards without requiring optional phone or website', () => {
  const result = normalization.normalizeCompanyCard(card({
    companyName: '  «ООО Ромашка»  ', sourceName: '', phone: null, website: null,
  }))
  assert.equal(result.companyName, '«ООО Ромашка»')
  assert.equal(result.sourceName, '«ООО Ромашка»')
  assert.equal(result.normalizedName, 'ромашка')
  assert.equal(result.normalizedPhone, null)
  assert.equal(result.normalizedDomain, null)
  assert.deepEqual(result.validationErrors, [])
})

test('flags missing required fields but does not invent values', () => {
  const result = normalization.normalizeCompanyCard(card({ companyName: ' ', city: '', niche: '' }))
  assert.equal(result.companyName, '')
  assert.deepEqual(result.validationErrors, ['Название компании не указано.', 'Город не указан.', 'Ниша не указана.'])
})

test('normalizes Russian phone formatting and common website variations', () => {
  assert.equal(normalization.normalizePhone('+7 (999) 123-45-67'), '79991234567')
  assert.equal(normalization.normalizePhone('8 999 123 45 67'), '79991234567')
  assert.equal(normalization.normalizeDomain('https://www.Example.RU/path?q=1'), 'example.ru')
})

test('removes exact duplicates and keeps the most complete source card', () => {
  const sparse = normalized({ candidateId: 'a', sourceCardId: 'same-card', sourceUrl: null })
  const complete = normalized({
    candidateId: 'b', sourceCardId: 'same-card', phone: '+7 999 123-45-67',
    website: 'https://romashka.example', rating: 4.8, reviewCount: 240,
  })
  const result = duplicates.classifyDuplicates([sparse, complete])
  assert.equal(result.find((row) => row.candidate.candidateId === 'a').duplicateOfId, 'b')
  assert.equal(result.find((row) => row.candidate.candidateId === 'a').duplicateKind, 'exact')
  assert.equal(result.find((row) => row.candidate.candidateId === 'b').duplicateOfId, null)
})

test('weak composite matches are marked for review and never discarded as exact duplicates', () => {
  const first = normalized({ candidateId: 'a', sourceCardId: null, sourceUrl: null, phone: '+7 999 123-45-67' })
  const second = normalized({ candidateId: 'b', sourceCardId: null, sourceUrl: null, phone: '8 999 123 45 67' })
  const result = duplicates.classifyDuplicates([first, second])
  assert.equal(result.find((row) => row.candidate.candidateId === 'b').duplicateKind, 'possible')
  assert.equal(result.find((row) => row.candidate.candidateId === 'b').duplicateOfId, 'a')
})

test('similar names alone do not merge independent businesses', () => {
  const first = normalized({ candidateId: 'a', sourceCardId: 'one', sourceNetworkId: null, sourceUrl: null,
    companyName: 'Ромашка кафе', address: 'ул. Ленина, 1', city: 'Казань' })
  const second = normalized({ candidateId: 'b', sourceCardId: 'two', sourceNetworkId: null, sourceUrl: null,
    companyName: 'Ромашка кафе', address: 'ул. Пушкина, 90', city: 'Казань' })
  assert.deepEqual(branches.classifyBranchGroups([first, second]), [])
})

test('explicit shared network ID confirms a two-card branch group', () => {
  const first = normalized({ candidateId: 'a', sourceCardId: 'one', sourceNetworkId: 'network-7' })
  const second = normalized({ candidateId: 'b', sourceCardId: 'two', sourceNetworkId: 'network-7',
    address: 'ул. Пушкина, 90' })
  const groups = branches.classifyBranchGroups([first, second])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].classification, 'confirmed')
  assert.deepEqual(groups[0].memberIds, ['a', 'b'])
})

test('explicit shared network ID groups three or more branch cards together', () => {
  const cards = ['a', 'b', 'c'].map((candidateId, index) => normalized({
    candidateId,
    sourceCardId: `source-${candidateId}`,
    sourceNetworkId: 'network-8',
    address: `ул. Ленина, ${index + 1}`,
  }))
  const groups = branches.classifyBranchGroups(cards)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].classification, 'confirmed')
  assert.equal(groups[0].memberIds.length, 3)
})

test('shared domain, similar name, and distinct locations require review rather than auto-exclusion', () => {
  const first = normalized({ candidateId: 'a', sourceCardId: 'one', sourceNetworkId: null,
    companyName: 'Ромашка кофе', address: 'ул. Ленина, 1', website: 'https://romashka.example' })
  const second = normalized({ candidateId: 'b', sourceCardId: 'two', sourceNetworkId: null,
    companyName: 'Ромашка кофе', address: 'ул. Пушкина, 90', website: 'https://www.romashka.example/menu' })
  const groups = branches.classifyBranchGroups([first, second])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].classification, 'needs_review')
})

test('combined classification preserves duplicates and attaches branch evidence to every member', () => {
  const first = normalized({ candidateId: 'a', sourceCardId: 'one', sourceNetworkId: 'network-9' })
  const second = normalized({ candidateId: 'b', sourceCardId: 'two', sourceNetworkId: 'network-9', address: 'ул. Пушкина, 90' })
  const classified = classification.classifyCompanies([first, second])
  assert.deepEqual(classified.map((candidate) => candidate.branchClassification), ['confirmed', 'confirmed'])
  assert.equal(classified[0].branchGroupKey, classified[1].branchGroupKey)
  assert.equal(classified[0].duplicateOfId, null)
})

test('import run transitions reject unsafe jumps and allow idempotent repeats', () => {
  assert.equal(states.transitionImportRun('created', 'collecting'), 'collecting')
  assert.equal(states.transitionImportRun('collecting', 'collecting'), 'collecting')
  assert.throws(() => states.transitionImportRun('created', 'approved'), /Недопустимый переход/)
  assert.equal(states.canTransitionImportRun('completed', 'collecting'), false)
})

test('CSV keeps Russian text and quotes commas, newlines, and spreadsheet formulas', () => {
  const candidate = {
    ...normalized({ companyName: 'Кафе, "Север"', phone: null, website: null }),
    runId: 'run-local', duplicateOfId: null, duplicateKind: null, branchGroupKey: null,
    branchClassification: 'none', branchOverride: 'unreviewed', branchEvidence: [],
    userDecision: 'pending', importStatus: 'not_ready', importedLeadId: null, exclusionReason: 'Причина, "проверка"\nвторая строка',
  }
  const dangerous = { ...candidate, companyName: '=HYPERLINK("https://bad.invalid")' }
  const output = csv.importCandidatesToCsv([candidate, dangerous])
  assert.ok(output.startsWith('\uFEFF'))
  assert.ok(output.includes('"Кафе, ""Север"""'))
  assert.ok(output.includes('"Причина, ""проверка""\nвторая строка"'))
  assert.ok(output.includes('"\'=HYPERLINK(""https://bad.invalid"")"'))
})
