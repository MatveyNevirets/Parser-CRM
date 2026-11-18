import type { ImportCandidatePage, LocalImportServiceClient, PublicationReport } from './service.ts'
import type { ImportCandidate, ImportRun } from './types.ts'
import { localParserProtocolVersion } from './protocol.ts'

const localParserBase = 'http://127.0.0.1:43127'
const tokenStorageKey = 'pahota.local-parser-token.v1'
const developmentPairingToken = import.meta.env.DEV ? import.meta.env.VITE_LOCAL_PARSER_TOKEN : undefined

export function readLocalParserToken(): string | null {
  if (developmentPairingToken) return developmentPairingToken
  try { return sessionStorage.getItem(tokenStorageKey) } catch { return null }
}
export function clearLocalParserToken(): void {
  try { sessionStorage.removeItem(tokenStorageKey) } catch { /* no browser storage */ }
}

export async function connectLocalParser(token: string): Promise<void> {
  const clean = token.trim()
  if (clean.length < 32 || clean.length > 200) throw new Error('Введите токен из окна локального парсера.')
  await checkLocalParserHealth(clean)
  try { sessionStorage.setItem(tokenStorageKey, clean) }
  catch { throw new Error('Не удалось сохранить токен соединения в текущей вкладке.') }
}

export function localImportServiceClient(): LocalImportServiceClient {
  const token = () => readLocalParserToken() ?? ''
  return {
    health: () => checkLocalParserHealth(token()),
    listRuns: async (workspaceId, limit = 25) => {
      const data = await requestLocal<{ runs: ImportRun[] }>(`/v1/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`, token(), { method: 'GET' })
      return data.runs
    },
    getRun: async (workspaceId, runId) => {
      const data = await requestLocal<{ run: ImportRun } | { error: string }>(`${runPath(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`, token(), { method: 'GET' })
      return 'run' in data ? data.run : null
    },
    listCandidates: async (workspaceId, runId, page, pageSize, search = '') => {
      const query = new URLSearchParams({ workspaceId, page: String(page), pageSize: String(pageSize), search })
      return requestLocal<ImportCandidatePage>(`${runPath(runId)}/candidates?${query}`, token(), { method: 'GET' })
    },
    startRun: async (parameters, createdBy) => {
      const data = await requestLocal<{ run: ImportRun }>('/v1/runs', token(), { method: 'POST', body: JSON.stringify({ ...parameters, createdBy }) })
      return data.run
    },
    collectNextPage: async (workspaceId, runId) => {
      const data = await postRun<{ run: ImportRun }>(runId, 'collect', workspaceId, token())
      return data.run
    },
    cancelRun: async (workspaceId, runId) => (await postRun<{ run: ImportRun }>(runId, 'cancel', workspaceId, token())).run,
    continueRun: async (workspaceId, runId) => (await postRun<{ run: ImportRun }>(runId, 'continue', workspaceId, token())).run,
    rejectRun: async (workspaceId, runId) => (await postRun<{ run: ImportRun }>(runId, 'reject', workspaceId, token())).run,
    decideCandidates: (workspaceId, runId, candidateIds, decision) => postRun(runId, 'decision', workspaceId, token(), { candidateIds, decision }),
    reviewBranchGroup: (workspaceId, runId, groupKey, classification) => postRun(runId, 'branch-review', workspaceId, token(), { groupKey, classification }),
    editCandidate: async (workspaceId, runId, candidateId, fields) => {
      const data = await requestLocal<{ candidate: ImportCandidate }>(`${runPath(runId)}/candidate/${encodeURIComponent(candidateId)}/edit`, token(), {
        method: 'POST', body: JSON.stringify({ workspaceId, fields }),
      })
      return data.candidate
    },
    addCandidate: async (workspaceId, runId, fields) => {
      const data = await postRun<{ candidate: ImportCandidate }>(runId, 'candidates', workspaceId, token(), { fields })
      return data.candidate
    },
    deleteRun: async (workspaceId, runId) => {
      await requestLocal(`${runPath(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`, token(), { method: 'DELETE' })
    },
    preparePublication: async (workspaceId, runId) => {
      const data = await postRun<{ idempotencyKey: string }>(runId, 'publication-key', workspaceId, token())
      return data.idempotencyKey
    },
    recordPublication: async (workspaceId, runId, report: PublicationReport) => {
      const data = await postRun<{ run: ImportRun }>(runId, 'publication', workspaceId, token(), { report })
      return data.run
    },
  }
}

async function checkLocalParserHealth(token: string) {
  const health = await requestLocal<{ ok: true; storage: 'sqlite'; browser: 'local-chromium'; protocolVersion?: number }>(
    '/v1/health', token, { method: 'GET' },
  )
  if (health.protocolVersion !== localParserProtocolVersion) {
    throw new Error('Запущена устаревшая версия локального парсера. Остановите старый процесс и запустите npm run dev:connected заново. Сохранённый пакет останется доступен; повторный сбор не нужен.')
  }
  return { ...health, protocolVersion: health.protocolVersion }
}

function runPath(runId: string): string { return `/v1/runs/${encodeURIComponent(runId)}` }
function postRun<T = { ok: true }>(runId: string, action: string, workspaceId: string, token: string, body: Record<string, unknown> = {}): Promise<T> {
  return requestLocal<T>(`${runPath(runId)}/${action}`, token, { method: 'POST', body: JSON.stringify({ workspaceId, ...body }) })
}

async function requestLocal<T = Record<string, unknown>>(path: string, token: string, init: RequestInit): Promise<T> {
  if (!token) throw new Error('Подключите локальный процесс и введите его токен.')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 45_000)
  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${localParserBase}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
        credentials: 'omit', cache: 'no-store', mode: 'cors',
      })
      const result = await response.json().catch(() => null) as (T & { error?: string }) | null
      // The local server rejects a rate-limited request before any mutation.
      // Never retry ambiguous writes after a network failure or timeout.
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('Retry-After') ?? '10')
        await waitForLocalRetry(Number.isFinite(seconds) ? Math.max(100, Math.min(10_000, seconds * 1000)) : 10_000, controller.signal)
        continue
      }
      if (!response.ok) throw new Error(result?.error ?? `Локальный парсер вернул HTTP ${response.status}.`)
      if (!result) throw new Error('Локальный парсер вернул пустой ответ.')
      return result
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Локальный парсер не ответил за 45 секунд. Проверьте, что процесс работает.')
    if (error instanceof TypeError) throw new Error('Не удалось подключиться к локальному парсеру. Проверьте процесс и разрешённый CRM origin.')
    throw error
  } finally { window.clearTimeout(timeout) }
}

function waitForLocalRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, delayMs)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

