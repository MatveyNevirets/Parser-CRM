import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '../local-parser/node_modules/playwright/index.mjs'

// Isolated real-browser regression: real React and Supabase SDK, mocked remote API.
// Start dev/build with the test-only VITE_SUPABASE_* settings documented in README.
const baseURL = process.env.CRM_TEST_URL ?? 'http://127.0.0.1:5175'
const baseline = process.argv.includes('--baseline')
const headed = process.argv.includes('--headed')
let nativeBrowser
let browser
if (headed) {
  // Connecting without Playwright's forced-focus override gives native tab visibility.
  const profile = await mkdtemp(join(tmpdir(), 'pahota-crm-browser-test-'))
  nativeBrowser = spawn(chromium.executablePath(), ['--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpointURL = await new Promise((resolve, reject) => {
    let stderr = ''
    nativeBrowser.on('error', reject)
    nativeBrowser.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      const endpoint = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]
      if (endpoint) resolve(endpoint)
    })
    nativeBrowser.on('exit', (code) => reject(new Error(`Chromium exited: ${code}`)))
  })
  browser = await chromium.connectOverCDP(endpointURL, { noDefaults: true })
} else browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const context = headed ? browser.contexts()[0] : await browser.newContext()
const page = await context.newPage()
page.setDefaultTimeout(10_000)
await page.clock.install()
const errors = []
const consoleMessages = []
const requests = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => consoleMessages.push(message.text()))
page.on('request', (request) => requests.push({ url: request.url(), type: request.resourceType() }))
const userId = '00000000-0000-4000-8000-000000000001'
const workspaceId = '00000000-0000-4000-8000-000000000002'
const session = {
  access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test`,
  refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: userId, email: 'regression@example.test', aud: 'authenticated', role: 'authenticated' },
}
const lead = (id, company_name, website, website_status = 'unknown', status = 'newLead') => ({
  id, company_name, website, website_status, status, workspace_id: workspaceId,
  niche: 'Кафе', priority: 'normal', phone: null, notes: null, yandex_maps_url: null,
  next_action_at: '2026-11-20T00:00:00Z', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z',
  version: 1, is_deleted: false, archived_at: null, manually_queued_for_calls: false, excluded_from_automatic_calls: false,
})
const leads = [lead('1', 'Alpha', null), lead('2', 'Beta', 'example.com', 'unknown', 'waiting'),
  lead('3', 'Gamma', 'https://company.example', 'poorWebsite'),
  lead('4', 'Delta', 'https://vk.com/company', 'unknown', 'contacted'), lead('5', 'Epsilon', null, 'hasWebsite')]
const numbers = ['+7 (999) 999-99-99', '8 (999) 999-99-99', '89999999999', '+79999999999', '+70000000000']
leads.forEach((row, index) => { row.phone = numbers[index] })
leads[0].source_url = 'https://2gis.ru/volgograd/firm/1234'
Object.assign(leads[1], { city: 'Волгоград', address: 'ул. Мира, 10' })
leads[2].priority = 'high'
leads[3].yandex_maps_url = 'https://yandex.ru/maps/org/1234'
const calls = []
const outreach = []
const recordings = new Map()
const counts = { workspace: 0, leads: 0, writes: 0 }
await context.route('https://crm-regression.supabase.co/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  let body
  if (url.pathname.endsWith('/workspace_members')) {
    counts.workspace++
    // Make the original unmount visible and deterministic.
    await new Promise((resolve) => setTimeout(resolve, 80))
    body = { workspace_id: workspaceId }
  } else if (url.pathname.endsWith('/workspaces')) {
    body = { id: workspaceId, name: 'Regression Team', invite_code: 'test', owner_id: userId }
  } else if (url.pathname.endsWith('/leads')) {
    if (request.method() === 'PATCH') {
      counts.writes++
      const id = url.searchParams.get('id')?.slice(3)
      const row = leads.find((item) => item.id === id)
      assert.ok(row)
      assert.equal(url.searchParams.get('version'), `eq.${row.version}`)
      const patch = request.postDataJSON()
      if (patch.status && row.status !== patch.status) patch.excluded_from_automatic_calls = false
      Object.assign(row, patch, { version: row.version + 1 })
      body = [{ id }]
    } else { counts.leads++; body = leads.filter((item) => !item.is_deleted) }
  } else if (url.pathname.endsWith('/lead_calls') || url.pathname.endsWith('/lead_outreach')) {
    const rows = url.pathname.endsWith('/lead_calls') ? calls : outreach
    const id = url.searchParams.get('lead_id')?.slice(3)
    body = rows.filter((row) => row.lead_id === id).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  } else if (url.pathname.endsWith('/rpc/save_lead_call')) {
    const data = request.postDataJSON()
    calls.push({ id: data.p_id, lead_id: data.p_lead_id, occurred_at: data.p_occurred_at, outcome: data.p_outcome,
      went_well: data.p_went_well, went_poorly: data.p_went_poorly, notes: data.p_notes,
      audio_mime: data.p_audio_mime, audio_duration_seconds: data.p_audio_duration })
    if (data.p_audio_base64) recordings.set(data.p_id, data.p_audio_base64)
    body = null
  } else if (url.pathname.endsWith('/rpc/get_lead_call_audio')) {
    body = recordings.get(request.postDataJSON().p_call_id)
  } else if (url.pathname.endsWith('/rpc/attach_lead_call_audio')) {
    const data = request.postDataJSON()
    const call = calls.find((item) => item.id === data.p_call_id)
    assert.equal(call.audio_mime, null)
    call.audio_mime = data.p_mime
    call.audio_duration_seconds = data.p_duration
    recordings.set(call.id, data.p_base64)
    body = null
  } else if (url.pathname.endsWith('/rpc/mark_mailing_message')) {
    const data = request.postDataJSON()
    const row = leads.find((lead) => lead.id === data.p_lead_id)
    assert.equal(row.version, data.p_version)
    assert.equal(row.status, 'newLead')
    Object.assign(row, { status: 'inProgress', version: row.version + 1 })
    outreach.push({ id: data.p_id, lead_id: data.p_lead_id, kind: 'telegram_message', occurred_at: new Date().toISOString() })
    body = null
  } else if (url.pathname.endsWith('/rpc/crm_sales_statistics')) {
    const active = leads.filter((lead) => !lead.archived_at)
    const queue = active.filter((lead) => lead.manually_queued_for_calls || (lead.status === 'waiting' && !lead.excluded_from_automatic_calls))
    const newNormal = active.filter((lead) => lead.priority === 'normal' && lead.status === 'newLead')
    body = { total: newNormal.length, mailing: newNormal.filter((lead) => !queue.includes(lead)).length,
      archived: leads.length - active.length, calls_queue: queue.length,
      rejected_or_hidden: leads.filter((lead) => lead.archived_at || lead.status === 'rejected').length,
      messaged: new Set(outreach.map((event) => event.lead_id)).size,
      offers: outreach.filter((event) => event.kind === 'telegram_offer').length,
      waiting: leads.filter((lead) => lead.status === 'waiting').length, calls_made: calls.filter((call) => call.outcome).length,
      interested: new Set(calls.filter((call) => call.outcome === 'interested').map((call) => call.lead_id)).size }
  } else if (url.pathname.endsWith('/logout')) body = {}
  else if (url.pathname.endsWith('/user')) body = session.user
  else throw new Error(`Unexpected API: ${request.method()} ${url.pathname}`)
  if (body === null) await route.fulfill({ status: 204 })
  else await route.fulfill({ json: body })
})
await context.route('https://t.me/**', (route) => route.fulfill({ body: 'Telegram link regression' }))
await context.routeWebSocket('wss://crm-regression.supabase.co/**', (socket) => {
  socket.onMessage((raw) => {
    const message = JSON.parse(raw.toString())
    if (message.event === 'phx_join' || message.event === 'heartbeat') {
      socket.send(JSON.stringify({ topic: message.topic, event: 'phx_reply', ref: message.ref,
        payload: { status: 'ok', response: { postgres_changes: [] } } }))
    }
  })
})
await context.addInitScript(({ session }) => {
  if (!localStorage.getItem('sb-crm-regression-auth-token')) {
    localStorage.setItem('sb-crm-regression-auth-token', JSON.stringify(session))
  }
}, { session })

async function lifecycle() {
  // Dispatch the same DOM lifecycle consumed by Supabase (window) and useLeads (document).
  for (const visibility of ['hidden', 'visible']) {
    await page.evaluate((visibility) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility })
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
      window.dispatchEvent(new Event(visibility === 'hidden' ? 'blur' : 'focus'))
    }, visibility)
  }
  await page.waitForTimeout(400)
}
async function rows(names) {
  await page.waitForFunction((names) => JSON.stringify([...document.querySelectorAll('.company-cell strong')].map((el) => el.textContent)) === JSON.stringify(names), names)
}

async function salesWorkflows() {
  const dialog = page.getByRole('dialog')
  const company = (name) => page.locator('.lead-row').filter({ has: page.getByRole('button', { name: new RegExp(`^${name} `) }) })
  const open = (name) => company(name).locator('.company-cell').click()
  const edit = (name) => company(name).getByTitle('Редактировать').click()
  const close = () => dialog.getByLabel('Закрыть', { exact: true }).click()
  const showCalls = () => page.getByRole('button', { name: /^Звонки / }).click()
  const showMailing = () => page.getByRole('button', { name: /^Рассылка / }).click()
  const showAll = () => page.getByRole('button', { name: /^Все / }).click()
  const status = () => dialog.getByRole('combobox', { name: 'Статус лида' })
  const save = async (button = 'Сохранить') => {
    await dialog.getByRole('button', { name: button, exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  }

  await page.getByRole('button', { name: 'Лиды', exact: true }).click()
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click()
  await rows(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
  for (const [index, name] of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].entries()) {
    await open(name)
    assert.equal(await dialog.getByText('Следующее действие', { exact: true }).count(), 0)
    if (index === 4) assert.equal(await dialog.getByRole('button', { name: 'Проверить Telegram' }).isDisabled(), true)
    else {
      const telegram = dialog.getByRole('link', { name: 'Проверить Telegram' })
      assert.equal(await telegram.getAttribute('href'), 'https://t.me/+79999999999')
      assert.equal(await telegram.getAttribute('target'), '_blank')
      if (index === 0) {
        const popup = page.waitForEvent('popup')
        await telegram.click()
        const opened = await popup
        await opened.waitForURL('https://t.me/+79999999999')
        await opened.close()
      }
    }
    await close()
  }

  await edit('Delta')
  assert.equal(await dialog.getByLabel('Ссылка на Яндекс Карты').count(), 0)
  assert.equal(await status().inputValue(), 'inProgress')
  assert.equal(await status().locator('option[value=contacted]').count(), 0)
  assert.equal(await status().locator('option[value=qualified]').count(), 0)
  assert.equal(await dialog.getByRole('button', { name: /^(Прозвонить|Убрать)$/ }).count(), 0)
  await dialog.getByLabel('Заметки').fill('Заметка к прежней карточке')
  await save()
  assert.equal(leads[3].status, 'inProgress')
  assert.equal(leads[3].yandex_maps_url, 'https://yandex.ru/maps/org/1234')

  await showCalls()
  await rows(['Beta'])
  await showMailing()
  await rows(['Epsilon'])
  await showAll()
  await edit('Alpha')
  await status().selectOption('newLead')
  await save()
  await showMailing()
  await rows(['Alpha', 'Epsilon'])
  await open('Alpha')
  assert.equal(await dialog.getByRole('button', { name: 'Отметить оффер' }).count(), 0)
  await save('Отметить сообщение')
  assert.equal(leads[0].status, 'inProgress')
  await rows(['Epsilon'])
  await showAll()
  await open('Alpha')
  await dialog.getByText('Сообщение в Telegram', { exact: true }).waitFor()
  await close()
  await edit('Alpha')
  await status().selectOption('newLead')
  await save()
  await showMailing()
  await open('Alpha')
  await save('Прозвонить')
  await page.getByText('Лид добавлен в список прозвонов.').waitFor()
  assert.equal(leads[0].status, 'waiting')
  await rows(['Epsilon'])
  await showAll()
  await open('Alpha')
  assert.equal(await dialog.getByRole('button', { name: 'Уже на прозвоне' }).isDisabled(), true)
  await close()
  await showCalls()
  await rows(['Alpha', 'Beta'])
  await edit('Alpha')
  await status().selectOption('inProgress')
  await save()
  await rows(['Alpha', 'Beta'])
  await edit('Beta')
  await status().selectOption('newLead')
  await save()
  await rows(['Alpha'])
  await showMailing()
  await edit('Beta')
  await status().selectOption('waiting')
  await save()
  await showCalls()
  await rows(['Alpha', 'Beta'])

  await open('Alpha')
  const twoGis = dialog.getByRole('link', { name: 'Открыть в 2ГИС' })
  assert.equal(await twoGis.getAttribute('href'), leads[0].source_url)
  assert.equal(await twoGis.getAttribute('target'), '_blank')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Копировать номер' }).click()
  await dialog.getByText('Номер скопирован.').waitFor()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), numbers[0])
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'))
  })
  await dialog.getByRole('button', { name: 'Начать запись' }).click()
  await dialog.getByRole('alert').filter({ hasText: 'Доступ к микрофону запрещён' }).waitFor()
  await page.evaluate(() => { delete navigator.mediaDevices.getUserMedia })
  await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Начать запись' }).click()
  await dialog.getByText(/Идёт запись/).waitFor()
  await dialog.getByText('0:01', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Остановить запись' }).click()
  const preview = dialog.locator('audio[aria-label="Предпросмотр записи"]')
  await preview.waitFor()
  await preview.evaluate((audio) => audio.play())
  await dialog.getByLabel('Результат звонка').selectOption('interested')
  await dialog.getByLabel('Что было хорошо').fill('Представился')
  await dialog.getByLabel('Что было плохо').fill('Пауза')
  await dialog.getByLabel('Общие заметки').fill('Перезвонить по запросу')
  await dialog.getByRole('button', { name: 'Сохранить звонок', exact: true }).click()
  await dialog.getByText('Звонок сохранён.').waitFor()
  await dialog.getByText('Перезвонить по запросу', { exact: true }).waitFor()
  assert.ok(calls[0].audio_duration_seconds >= 1)
  assert.ok(Buffer.from(recordings.get(calls[0].id), 'base64').length > 100)

  const fileInput = dialog.getByLabel('Загрузить аудио')
  await fileInput.setInputFiles({ name: 'wrong.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(44) })
  await dialog.getByRole('alert').filter({ hasText: 'Поддерживаются аудио' }).waitFor()
  const wav = Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000', 'hex')
  const audioFile = { name: 'call.wav', mimeType: 'audio/wav', buffer: wav }
  await fileInput.setInputFiles(audioFile)
  await dialog.getByText('Файл готов к сохранению.').waitFor()
  await dialog.getByRole('button', { name: 'Сохранить и дальше' }).click()
  await dialog.getByRole('heading', { name: 'Beta' }).waitFor()
  assert.equal(decodeURIComponent(await dialog.getByRole('link', { name: 'Найти в 2ГИС' }).getAttribute('href')),
    'https://2gis.ru/search/Beta Волгоград ул. Мира, 10')
  await close()

  await open('Alpha')
  await dialog.getByLabel('Результат звонка').selectOption('no_answer')
  await dialog.getByRole('button', { name: 'Сохранить звонок', exact: true }).click()
  const noAnswer = dialog.locator('.call-history-item').filter({ hasText: 'Не дозвонился' })
  await noAnswer.getByLabel('Прикрепить аудио').setInputFiles(audioFile)
  await noAnswer.getByText('Аудио прикреплено.').waitFor()
  await close()
  await page.reload()
  await showCalls()
  await rows(['Alpha', 'Beta'])
  await open('Alpha')
  await dialog.getByText('Заинтересован', { exact: true }).last().waitFor()
  assert.equal(await dialog.locator('.call-history-item').count(), 3)
  const recorded = dialog.locator('.call-history-item').filter({ hasText: 'Перезвонить по запросу' })
  await recorded.getByRole('button', { name: 'Открыть запись' }).click()
  await recorded.locator('audio').evaluate((audio) => audio.play())
  await noAnswer.getByRole('button', { name: 'Открыть запись' }).click()
  const startDownload = page.waitForEvent('download')
  await noAnswer.getByRole('link', { name: 'Скачать запись' }).click()
  const download = await startDownload
  assert.match(download.suggestedFilename(), /\.wav$/)
  assert.equal(await download.failure(), null)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await page.setViewportSize({ width: 1280, height: 900 })
  await close()

  await showAll()
  await open('Alpha')
  await dialog.getByRole('button', { name: 'Убрать', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await confirm.getByText('Убрать эту карточку из рассылки? Она будет перемещена в архив и не появится повторно при парсинге').waitFor()
  await confirm.getByRole('button', { name: 'Отмена' }).click()
  await dialog.getByRole('button', { name: 'Убрать', exact: true }).click()
  await confirm.getByRole('button', { name: 'Убрать в архив' }).click()
  await rows(['Beta', 'Gamma', 'Delta', 'Epsilon'])
  await page.getByRole('button', { name: 'Статистика', exact: true }).click()
  for (const [label, expected] of [['Всего', '5'], ['Рассылка', '1'], ['Лиды, которым написали', '39'],
    ['Отправлено офферов', '0'], ['Звонки с результатом', '2']]) {
    const card = page.locator('.stat-card').filter({ hasText: label })
    await card.getByText(expected, { exact: true }).waitFor()
  }
  for (const label of ['В архиве', 'Заинтересованные лиды', 'В статусе «Отложен»', 'Отказ / скрыто']) {
    assert.equal(await page.locator('.stat-card').getByText(label, { exact: true }).count(), 0)
  }
  await page.getByRole('button', { name: 'Архив', exact: true }).click()
  await page.getByLabel('Поиск', { exact: true }).fill('89999999999')
  await rows(['Alpha'])
  await open('Alpha')
  await dialog.getByText('Сообщение в Telegram', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'История звонков' }).click()
  await dialog.getByText('Перезвонить по запросу', { exact: true }).waitFor()
  await close()
  await open('Alpha')
  await dialog.getByRole('button', { name: 'Восстановить' }).click()
  await rows([])
  await page.getByRole('button', { name: 'Лиды', exact: true }).click()
  await rows(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
  await showCalls()
  await rows(['Alpha', 'Beta'])
  await open('Beta')
  await dialog.getByLabel('Общие заметки').fill('Заметки перед возвратом')
  await dialog.getByRole('button', { name: 'Вернуть в общее' }).click()
  await page.getByText('Лид возвращён в общий список.').waitFor()
  assert.equal(leads[1].status, 'newLead')
  assert.equal(calls.filter((call) => call.lead_id === leads[1].id && call.notes === 'Заметки перед возвратом').length, 1)
  await rows(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
  await page.reload()
  await showCalls()
  await rows(['Alpha'])
  await open('Alpha')
  await dialog.getByRole('button', { name: 'Вернуть в общее' }).click()
  await page.getByText('Лид возвращён в общий список.').waitFor()
  assert.equal(leads[0].manually_queued_for_calls, false)
  assert.equal(leads[0].status, 'newLead')
  await showMailing()
  await rows(['Alpha', 'Beta', 'Epsilon'])
  console.log('PASS: Telegram links, legacy status, queues, archive, statistics, recording, uploads, playback, download and reload')
}
try {
  await page.goto(baseURL)
  await rows(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
  await page.getByLabel('Ниша', { exact: true }).selectOption('Кафе')
  await page.getByLabel('Поиск', { exact: true }).fill('Alpha')
  await page.getByTitle('Редактировать', { exact: true }).click()
  await page.getByLabel('Заметки', { exact: true }).fill('Unsaved focus regression draft')
  const shell = await page.locator('.app-shell').elementHandle()
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  const before = { ...counts }
  await lifecycle()
  const evidence = {
    browserReload: await page.evaluate(() => performance.timeOrigin) !== timeOrigin,
    dashboardUnmounted: !await shell.evaluate((element) => element.isConnected),
    draftPreserved: await page.getByRole('dialog').locator('textarea').count() === 1,
    workspaceReloads: counts.workspace - before.workspace,
    leadRefetches: counts.leads - before.leads,
    documentRequests: requests.filter((item) => item.type === 'document').length,
  }
  console.log(JSON.stringify({ mode: baseline ? 'before-fix' : 'after-fix', focus: evidence }))
  assert.equal(evidence.browserReload, false)
  if (baseline) {
    assert.equal(evidence.dashboardUnmounted, true)
    assert.equal(evidence.draftPreserved, false)
    assert.ok(evidence.workspaceReloads > 0)
  } else {
    assert.equal(evidence.dashboardUnmounted, false)
    assert.equal(evidence.workspaceReloads, 0)
    assert.ok(evidence.leadRefetches > 0, 'Background sync must still run')
    assert.equal(await page.getByRole('dialog').locator('textarea').inputValue(), 'Unsaved focus regression draft')
    assert.equal(await page.getByLabel('Поиск', { exact: true }).inputValue(), 'Alpha')
    if (headed) {
      await page.evaluate(() => { delete document.visibilityState })
      const cdp = await context.newCDPSession(page)
      const newTab = context.waitForEvent('page')
      await page.evaluate(() => { window.open('about:blank', '_blank') })
      const otherTab = await newTab
      await otherTab.bringToFront()
      await page.waitForFunction(() => document.visibilityState === 'hidden')
      await page.bringToFront()
      await page.waitForFunction(() => document.visibilityState === 'visible')
      await page.waitForTimeout(400)
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await page.waitForFunction(() => document.visibilityState === 'hidden')
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await page.bringToFront()
      await page.waitForFunction(() => document.visibilityState === 'visible')
      await page.waitForTimeout(400)
      assert.equal(await shell.evaluate((element) => element.isConnected), true)
      assert.equal(await page.getByRole('dialog').locator('textarea').inputValue(), 'Unsaved focus regression draft')
      assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
      await otherTab.close()
      console.log('PASS: actual browser tab switch and window minimize/restore')
    }
    const beforeTimer = counts.leads
    await page.clock.fastForward(120_000)
    await page.waitForTimeout(400)
    assert.ok(counts.leads > beforeTimer, 'Periodic reconciliation must still run')
    assert.equal(await page.getByRole('dialog').locator('textarea').inputValue(), 'Unsaved focus regression draft')
    await page.getByLabel('Закрыть', { exact: true }).click()
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click()
    for (const width of [1440, 1100, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
        `Filters must fit the viewport at ${width}px`)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByLabel('Сайт', { exact: true }).selectOption('hasWebsite')
    await rows(['Beta', 'Gamma', 'Epsilon'])
    await page.getByLabel('Сайт', { exact: true }).selectOption('noWebsite')
    await rows(['Alpha', 'Delta'])
    await page.getByLabel('Сайт', { exact: true }).selectOption('')
    await rows(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
    await page.getByLabel('Поиск', { exact: true }).fill('Alpha')
    await page.getByTitle('Редактировать', { exact: true }).click()
    await page.getByRole('combobox', { name: /^Статус лида/ }).selectOption('offer')
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(leads[0].status, 'offer')
    assert.equal(counts.writes, 1)
    await page.reload()
    await page.getByLabel('Статус', { exact: true }).selectOption('offer')
    await page.getByLabel('Сайт', { exact: true }).selectOption('noWebsite')
    await rows(['Alpha'])
    await page.getByRole('button', { name: 'Alpha', exact: false }).click()
    assert.ok((await page.getByRole('dialog').innerText()).includes('Оффер'))
    await lifecycle()
    assert.equal(await page.getByRole('dialog').count(), 1)
    // Auth refresh / repeated sign-in from another tab must also preserve the card.
    await page.evaluate((session) => {
      const channel = new BroadcastChannel('sb-crm-regression-auth-token')
      channel.postMessage({ event: 'TOKEN_REFRESHED', session })
      channel.close()
    }, session)
    await page.waitForTimeout(200)
    assert.equal(await page.getByRole('dialog').count(), 1)
    await page.getByLabel('Закрыть', { exact: true }).click()
    await page.reload()
    await rows(['Alpha'])
    assert.equal(await page.getByLabel('Статус', { exact: true }).inputValue(), 'offer')
    assert.equal(await page.getByLabel('Сайт', { exact: true }).inputValue(), 'noWebsite')
    await page.getByRole('button', { name: 'Обзор', exact: true }).click()
    await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor()
    await lifecycle()
    assert.equal(await page.getByRole('heading', { name: 'Обзор', exact: true }).count(), 1)
    if (!headed) await salesWorkflows()
    await page.getByTitle('Выйти', { exact: true }).click()
    await page.getByRole('button', { name: 'Войти', exact: true }).waitFor()
    console.log('PASS: filters, offer PATCH/reload/details, draft/card/section preservation, token refresh, sign-out')
  }
  assert.deepEqual(errors, [])
  assert.equal(consoleMessages.some((message) => /\[vite\].*(reload|update)/i.test(message)), false)
  console.log(JSON.stringify({ pageErrors: errors, vite: consoleMessages.filter((message) => message.includes('[vite]')), counts }))
} finally {
  if (nativeBrowser) {
    const shutdown = await browser.newBrowserCDPSession()
    await shutdown.send('Browser.close').catch(() => {})
    nativeBrowser.kill()
  }
  await browser.close()
}
