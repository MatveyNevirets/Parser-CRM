import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '../local-parser/node_modules/playwright/index.mjs'
import { SqliteImportStore } from '../local-parser/.test-output/local-parser/src/sqliteStore.js'
import { LocalImportService } from '../local-parser/.test-output/local-parser/src/importService.js'

// Real service, SQLite and React. Source/API traffic is isolated from working data.
const folder = await mkdtemp(join(tmpdir(), 'pahota-parser-browser-'))
const workspaceId = randomUUID()
const userId = randomUUID()
const store = await SqliteImportStore.open(join(folder, 'imports.sqlite'))
const cards = [
  { sourceCardId: '101', companyName: 'Компания с сайтом', website: 'https://company.example/contacts', websiteCheckStatus: 'present' },
  { sourceCardId: '102', companyName: 'Компания без сайта', website: null, websiteCheckStatus: 'absent' },
  { sourceCardId: '103', companyName: 'Проверка не удалась', website: null, websiteCheckStatus: 'unknown' },
  ...Array.from({ length: 125 }, (_, i) => ({ sourceCardId: String(1000 + i), companyName: `Подходящая компания ${i}`, website: null, websiteCheckStatus: 'absent' })),
  { sourceCardId: '9999', companyName: 'Исключена вручную', website: null, websiteCheckStatus: 'absent' },
].map((c) => ({ sourceNetworkId: null, sourceName: c.companyName, city: 'Казань', address: null, niche: 'Кафе', phone: null,
  websiteCheckVersion: 2, websiteCheckedAt: new Date().toISOString(), websiteCheckedSourceUrl: `https://2gis.ru/kazan/firm/${c.sourceCardId}`,
  sourceUrl: `https://2gis.ru/kazan/firm/${c.sourceCardId}`, rating: null, reviewCount: null, latitude: null, longitude: null, ...c }))
const service = new LocalImportService(store, { createSession: ({ runId }) => {
  let done = false
  const snapshot = (status) => ({ runId, jobId: 'fixture', status, pageIndex: done ? 1 : 0, rawFound: done ? cards.length : 0,
    message: null, stopReason: null, canContinue: false })
  return { runId, canContinue: false, start: async () => snapshot('collecting'), snapshot: () => snapshot(done ? 'ready_for_review' : 'collecting'),
    nextPage: async () => done ? null : { pageId: 'fixture', pageIndex: 0, cards, hasMore: false, sourceComplete: false, reportedTotal: null, limitations: [], stopReason: null },
    acknowledge: () => { done = true; return snapshot('collecting') }, cancel: async () => snapshot('cancelled'), dispose: async () => {},
  }
} })
let vite
let browser
try {
  const run = await service.startRun({ workspaceId, source: '2gis', city: 'Казань', niche: 'Кафе', requestedCount: 0 }, userId)
  assert.equal(run.storedCount, cards.length)
  await service.cancelRun(workspaceId, run.id)
  const all = await service.listCandidates(workspaceId, run.id, 1, 100)
  const manuallyExcluded = all.items.find((candidate) => candidate.companyName === 'Исключена вручную')
  assert.ok(manuallyExcluded)
  await service.decideCandidates(workspaceId, run.id, [manuallyExcluded.candidateId], 'exclude')
  const moduleId = 'virtual:parser-regression'
  vite = await createServer({ configFile: false, envFile: false, cacheDir: join(folder, 'vite-cache'),
    server: { host: '127.0.0.1', port: 5189 },
    plugins: [react(), { name: 'parser-regression', resolveId: (id) => id === moduleId ? `\0${id}` : null,
      load: (id) => id === `\0${moduleId}` ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ParserPage } from '/src/components/ParserPage.tsx';
        const query = { select(){return this}, eq(){return this}, order(){return this}, async limit(){return {data:[],error:null}} };
        window.remotePublicationCalls = 0;
        const client = { from(){return query}, rpc(name, args){
          if (name === 'preview_local_import_publication') {
            window.lastPublicationPreview = args;
            return Promise.resolve({ data:{
            to_create:args.p_candidates.length,already_exists:0,excluded:args.p_excluded_count,selected:args.p_candidates.length
            }, error:null });
          }
          window.remotePublicationCalls++;
          throw new Error('Publication is forbidden in this test');
        } };
        createRoot(document.getElementById('root')).render(React.createElement(ParserPage, {
          client, workspaceId:${JSON.stringify(workspaceId)}, userId:${JSON.stringify(userId)}
        }));
      ` : null }] })
  await vite.listen()
  const baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const errors = []
  const decisionBatchSizes = []
  let rateLimitedOnce = false
  let legacyCompanion = false
  page.on('pageerror', (error) => errors.push(error.message))
  await context.addInitScript(() => sessionStorage.setItem('pahota.local-parser-token.v1', 'parser-browser-regression-token-123456789'))
  await context.route('http://127.0.0.1:43127/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = { 'Access-Control-Allow-Origin': baseURL, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    let result
    const runId = url.pathname.split('/')[3]
    if (url.pathname === '/v1/health') result = { ok: true, storage: 'sqlite', browser: 'local-chromium', ...(legacyCompanion ? {} : { protocolVersion: 5 }) }
    else if (url.pathname === '/v1/runs' && request.method() === 'POST') {
      const { createdBy, ...options } = request.postDataJSON()
      assert.equal(options.excludeWithWebsite, false)
      const created = await service.startRun(options, createdBy)
      result = { run: await service.cancelRun(workspaceId, created.id) }
    }
    else if (url.pathname === '/v1/runs') result = { runs: await service.listRuns(workspaceId) }
    else if (url.pathname.endsWith('/candidates') && request.method() === 'POST') {
      result = { candidate: await service.addCandidate(workspaceId, runId, request.postDataJSON().fields) }
    }
    else if (url.pathname.endsWith('/candidates')) result = await service.listCandidates(workspaceId, runId,
      Number(url.searchParams.get('page')), Number(url.searchParams.get('pageSize')), url.searchParams.get('search') ?? '')
    else if (url.pathname.endsWith('/decision')) {
      const body = request.postDataJSON()
      if (body.candidateIds.length === 100 && !rateLimitedOnce) {
        rateLimitedOnce = true
        return route.fulfill({ status: 429, headers: { ...headers, 'Retry-After': '0.1' }, json: { error: 'Local API rate limit' } })
      }
      decisionBatchSizes.push(body.candidateIds.length)
      await service.decideCandidates(workspaceId, runId, body.candidateIds, body.decision)
      result = { ok: true }
    } else if (url.pathname === `/v1/runs/${runId}`) result = { run: await service.getRun(workspaceId, runId) }
    else throw new Error(`Unexpected parser request: ${url.pathname}`)
    return route.fulfill({ json: result, headers })
  })
  await page.route(baseURL + '/', async (route) => route.fulfill({ contentType: 'text/html', body:
    await vite.transformIndexHtml('/', `<html><body><div id="root"></div><script type="module" src="/@id/${moduleId}"></script></body></html>`) }))
  await page.goto(baseURL)
  await page.getByRole('button', { name: /Кафе · Казань/ }).click()
  const siteCard = page.locator('.candidate-row').filter({ hasText: 'Компания с сайтом' })
  assert.equal(await siteCard.locator('.candidate-website a').getAttribute('href'), 'https://company.example/contacts')
  assert.equal(await siteCard.locator('.candidate-badge').innerText(), 'Исключена: есть сайт')
  assert.equal(await siteCard.getByRole('button', { name: 'Включить', exact: true }).isDisabled(), true)
  await siteCard.getByRole('button', { name: 'Править', exact: true }).click()
  assert.equal(await page.getByRole('dialog').getByLabel('Сайт', { exact: true }).inputValue(), 'https://company.example/contacts')
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click()
  const noSiteCard = page.locator('.candidate-row').filter({ hasText: 'Компания без сайта' })
  await noSiteCard.getByRole('button', { name: 'Включить', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Включено карточек: 1.' }).waitFor()
  await page.getByRole('button', { name: 'Проверить публикацию · 1', exact: true }).waitFor()
  assert.equal(await noSiteCard.locator('.candidate-badge').innerText(), 'Готова')
  assert.match(await page.getByRole('status').innerText(), /Включено карточек: 1/)
  const unchecked = page.locator('.candidate-row').filter({ hasText: 'Проверка не удалась' })
  assert.equal(await unchecked.locator('.candidate-badge').innerText(), 'Не проверена')
  await unchecked.getByRole('button', { name: 'Выбрать Проверка не удалась', exact: true }).click()
  assert.equal(await unchecked.locator('.candidate-select').getAttribute('aria-pressed'), 'true')
  await unchecked.getByRole('button', { name: 'Выбрать Проверка не удалась', exact: true }).click()
  assert.equal(await unchecked.locator('.candidate-select').getAttribute('aria-pressed'), 'false')
  await page.getByRole('button', { name: 'Выбрать все не исключённые', exact: true }).click()
  await page.getByText('Выбрано: 127 во всём пакете', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Дальше', exact: true }).click()
  await page.getByText(/страница 2 из 4/).waitFor()
  assert.equal(await page.locator('.candidate-select[aria-pressed="true"]').count(), 40)
  assert.equal(await page.getByText('Выбрано: 127 во всём пакете', { exact: true }).count(), 1)
  await page.getByRole('button', { name: 'Включить выбранные', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Включено карточек: 127.' }).waitFor()
  await page.getByRole('button', { name: 'Проверить публикацию · 127', exact: true }).waitFor()
  assert.deepEqual(decisionBatchSizes, [1, 100, 27])
  assert.equal(rateLimitedOnce, true)
  assert.match(await page.getByRole('status').innerText(), /Включено карточек: 127/)
  await page.reload()
  await page.getByRole('button', { name: /Кафе · Казань/ }).click()
  await page.getByRole('button', { name: 'Проверить публикацию · 127', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Включить все подходящие', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Включено карточек: 127' }).waitFor()
  const results = [...(await service.listCandidates(workspaceId, run.id, 0, 100)).items,
    ...(await service.listCandidates(workspaceId, run.id, 1, 100)).items]
  assert.equal(results.filter((c) => c.importStatus === 'ready').length, 127)
  assert.equal(results.find((c) => c.candidateId === manuallyExcluded.candidateId).userDecision, 'exclude')
  assert.ok(await service.preparePublication(workspaceId, run.id))
  await page.getByRole('button', { name: 'Проверить публикацию · 127', exact: true }).click()
  await page.getByRole('dialog').getByRole('heading', { name: 'Подтвердить публикацию?' }).waitFor()
  const changed = results.find((c) => c.companyName === 'Компания без сайта')
  await service.editCandidate(workspaceId, run.id, changed.candidateId, {
    companyName: changed.companyName, city: changed.city, address: changed.address ?? '', niche: changed.niche,
    phone: changed.phone ?? '', website: 'https://discovered-after-preview.example',
  })
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить и опубликовать', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Карточки изменились после предварительного отчёта' }).waitFor()
  assert.equal(await page.evaluate(() => window.remotePublicationCalls), 0, 'A stale no-site preview must never reach the remote publication RPC')
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить карточку', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Название', { exact: true }).fill('Ручная компания')
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить локально', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('textbox', { name: 'Поиск по локальному пакету' }).fill('Ручная компания')
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  const manual = page.locator('.candidate-row').filter({ hasText: 'Ручная компания' })
  await manual.getByRole('button', { name: 'Выбрать Ручная компания', exact: true }).click()
  assert.equal(await manual.locator('.candidate-select').getAttribute('aria-pressed'), 'true')
  await service.addCandidate(workspaceId, run.id, {
    companyName: 'Ручная компания обновление', city: run.city, niche: run.niche, address: '', phone: '', website: '',
  })
  await page.getByText('Ручная компания обновление', { exact: true }).waitFor({ timeout: 25_000 })
  assert.equal(await page.getByRole('button', { name: 'Выбрать Ручная компания', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByRole('textbox', { name: 'Поиск по локальному пакету' }).inputValue(), 'Ручная компания')

  const websiteFilter = page.getByRole('checkbox', { name: 'Исключать, если есть сайт' })
  assert.equal(await websiteFilter.isChecked(), true)
  await websiteFilter.uncheck()
  await page.getByLabel('Город *').fill('Казань')
  await page.getByLabel('Ниша *').fill('Компании с сайтами')
  await page.getByRole('button', { name: 'Запустить локально' }).click()
  await page.getByText(/сайты разрешены/).waitFor()
  await siteCard.getByRole('button', { name: 'Включить', exact: true }).click()
  await page.getByRole('button', { name: 'Проверить публикацию · 1', exact: true }).click()
  await page.getByRole('dialog').getByRole('heading', { name: 'Подтвердить публикацию?' }).waitFor()
  const unfiltered = await page.evaluate(() => window.lastPublicationPreview)
  assert.equal(unfiltered.p_exclude_with_website, false)
  assert.equal(unfiltered.p_candidates[0].website, 'https://company.example/contacts')
  await page.reload()
  await page.getByRole('button', { name: /Компании с сайтами · Казань/ }).click()
  await siteCard.getByText('Готова', { exact: true }).waitFor()

  legacyCompanion = true
  await page.reload()
  await page.getByRole('alert').filter({ hasText: 'устаревшая версия локального парсера' }).waitFor()
  assert.equal(await page.getByRole('button', { name: /Кафе · Казань/ }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: website filter on/off; website payload; unchecked cards; bulk selection; live refresh; persisted decisions and filter mode')
} finally {
  await browser?.close()
  await vite?.close()
  service.close()
  await rm(folder, { recursive: true, force: true })
}
