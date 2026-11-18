import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AlertTriangle, Building2, Check, Download, ExternalLink, Info, LoaderCircle, Map as MapIcon, Play, RefreshCw, Search, ShieldCheck, Square, StopCircle, Trash2, X } from 'lucide-react'
import { getErrorMessage } from '../lib/errors'
import { getExistingNiches, previewLocalImportPublication, publishLocalImportCandidates, type PublicationPreview } from '../imports/repository'
import { clearLocalParserToken, connectLocalParser, localImportServiceClient, readLocalParserToken } from '../imports/localParserClient'
import type { ImportCandidate, ImportRun } from '../imports/types'
import type { CandidateFields } from '../imports/service'
import { importCandidatesToCsv } from '../imports/csv'
import { normalizeDomain } from '../imports/normalize'
import { hasCandidateWebsite, isReviewableImportRun, isEligibleForReview, isSelectableForBulkReview } from '../imports/review'
import { hasCurrentNoWebsiteCheck } from '../imports/websiteEvidence'

const pageSize = 40
const local = localImportServiceClient()

export function ParserPage({ client, workspaceId, userId }: { client: SupabaseClient; workspaceId: string; userId: string }) {
  const [token, setToken] = useState('')
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [niches, setNiches] = useState<string[]>([])
  const [runs, setRuns] = useState<ImportRun[]>([])
  const [run, setRun] = useState<ImportRun | null>(null)
  const [city, setCity] = useState('')
  const [niche, setNiche] = useState('')
  const [excludeWithWebsite, setExcludeWithWebsite] = useState(true)
  const [requestedCount, setRequestedCount] = useState('50')
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [candidateTotal, setCandidateTotal] = useState(0)
  const [candidatePage, setCandidatePage] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<ImportCandidate | null>(null)
  const [fields, setFields] = useState<CandidateFields | null>(null)
  const [preview, setPreview] = useState<PublicationPreview | null>(null)
  const [publishCandidates, setPublishCandidates] = useState<ImportCandidate[]>([])
  const [confirmPublish, setConfirmPublish] = useState(false)
  const autoCollecting = run?.status === 'collecting'
  const selectedRunId = useRef(run?.id)
  selectedRunId.current = run?.id
  const candidateRequest = useRef(0)
  const existingNiches = useMemo(() => [...new Set([...niches, niche].filter(Boolean))].sort(), [niches, niche])

  const loadRuns = useCallback(async (keepId?: string) => {
    if (!connected) return
    const next = await local.listRuns(workspaceId, 100)
    setRuns(next)
    const wanted = keepId ?? run?.id
    if (wanted) {
      const refreshed = next.find((item) => item.id === wanted) ?? await local.getRun(workspaceId, wanted)
      if (refreshed && selectedRunId.current === wanted) setRun(refreshed)
    }
  }, [connected, workspaceId, run?.id])

  const loadCandidates = useCallback(async (runId: string, page = candidatePage, term = search) => {
    const request = ++candidateRequest.current
    const result = await local.listCandidates(workspaceId, runId, page, pageSize, term)
    if (candidateRequest.current !== request || selectedRunId.current !== runId) return
    setCandidates(result.items)
    setCandidateTotal(result.total)
    setCandidatePage(page)
  }, [workspaceId, candidatePage, search])

  useEffect(() => {
    void getExistingNiches(client, workspaceId).then(setNiches).catch(() => setNiches([]))
  }, [client, workspaceId])

  useEffect(() => {
    const saved = readLocalParserToken()
    if (!saved) return
    setToken(saved)
    void local.health().then(() => setConnected(true)).catch((caught) => {
      setConnected(false); clearLocalParserToken(); setError(getErrorMessage(caught))
    })
  }, [])

  useEffect(() => {
    if (!connected) return
    void loadRuns()
  }, [connected, loadRuns])

  const refreshSelected = useCallback(async (runId: string, page = candidatePage, term = search) => {
    const refreshed = await local.getRun(workspaceId, runId)
    if (refreshed && selectedRunId.current === runId) setRun(refreshed)
    await loadRuns(runId)
    await loadCandidates(runId, page, term)
    return refreshed
  }, [workspaceId, candidatePage, search, loadCandidates, loadRuns])

  useEffect(() => {
    if (!connected || !run || busy) return
    const runId = run.id
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      const request = ++candidateRequest.current
      try {
        const [nextRuns, current, result] = await Promise.all([
          local.listRuns(workspaceId, 100), local.getRun(workspaceId, runId),
          local.listCandidates(workspaceId, runId, candidatePage, pageSize, search),
        ])
        if (cancelled || selectedRunId.current !== runId) return
        setRuns(nextRuns)
        if (current) setRun(current)
        if (candidateRequest.current === request) {
          setCandidates(result.items)
          setCandidateTotal(result.total)
        }
      } catch (caught) {
        if (!cancelled) setError(getErrorMessage(caught))
      } finally { pending = false }
    }
    const timer = window.setInterval(() => void refresh(), 20_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [connected, workspaceId, run?.id, candidatePage, search, busy])

  const connect = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try { await connectLocalParser(token); setConnected(true) }
    catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const start = async (event: FormEvent) => {
    event.preventDefault()
    const count = Number(requestedCount)
    if (!Number.isSafeInteger(count) || count < 0 || count > 5000) { setError('Количество должно быть целым числом от 0 до 5000.'); return }
    setBusy(true); setError(null); setNotice(''); setSelectedIds(new Set()); setAction('Открываем видимое окно Chromium…')
    try {
      const created = await local.startRun({ workspaceId, source: '2gis', city, niche, requestedCount: count, excludeWithWebsite }, userId)
      selectedRunId.current = created.id
      setRun(created); setCandidatePage(0); setSearch(''); setSearchInput(''); setCandidates([]); setCandidateTotal(0)
      await refreshSelected(created.id, 0, '')
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false); setAction('') }
  }

  const runCollectionAction = async (kind: 'cancel' | 'continue', target = run) => {
    if (!target) return
    const actionLabel = kind === 'cancel' ? 'Останавливаем сбор…'
        : target.stopReason === 'captcha_manual' ? 'Проверяем, снята ли CAPTCHA…'
          : target.stopReason === 'visible_results_exhausted' ? 'Повторяем загрузку результатов…'
            : 'Продолжаем сбор с техническим лимитом…'
    setBusy(true); setAction(actionLabel); setError(null)
    try {
      const updated = kind === 'cancel' ? await local.cancelRun(workspaceId, target.id) : await local.continueRun(workspaceId, target.id)
      setRun(updated)
      await refreshSelected(target.id, 0)
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false); setAction('') }
  }

  const selectRun = async (selected: ImportRun) => {
    setRun(selected); setCandidatePage(0); setSearch(''); setSearchInput(''); setError(null); setNotice(''); setSelectedIds(new Set())
    try { await loadCandidates(selected.id, 0, '') }
    catch (caught) { setError(getErrorMessage(caught)) }
  }

  const commitDecision = async (decision: 'include' | 'exclude', ids: string[]) => {
    if (!run || !isReviewableImportRun(run)) throw new Error('Этот пакет сейчас недоступен для проверки.')
    const uniqueIds = [...new Set(ids)]
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      setAction(`${decision === 'include' ? 'Включаем' : 'Исключаем'} карточки: ${Math.min(offset + 100, uniqueIds.length)} из ${uniqueIds.length}…`)
      await local.decideCandidates(workspaceId, run.id, uniqueIds.slice(offset, offset + 100), decision)
    }
    const updated = await refreshSelected(run.id)
    if (decision === 'include' && updated) {
      const selected = new Set(uniqueIds)
      const saved = (await allCandidates(updated)).filter((candidate) => selected.has(candidate.candidateId))
      const blocked = saved.find((candidate) => candidate.importStatus !== 'ready')
      if (blocked || saved.length !== uniqueIds.length) throw new Error(blocked?.exclusionReason
        ?? 'Часть карточек не готова к публикации. Проверьте их статус и причины исключения.')
    }
    setSelectedIds(new Set())
    setNotice(decision === 'include'
      ? `Включено карточек: ${uniqueIds.length}. Готовы к публикации в CRM.`
      : `Исключено карточек: ${uniqueIds.length}.`)
  }

  const decide = async (decision: 'include' | 'exclude', ids = [...selectedIds]) => {
    if (!run || !ids.length) return
    setBusy(true); setError(null); setNotice('')
    try { await commitDecision(decision, ids) }
    catch (caught) { setError(getErrorMessage(caught)); await refreshSelected(run.id).catch(() => {}) }
    finally { setBusy(false); setAction('') }
  }

  const selectAllEligible = async () => {
    if (!run || !isReviewableImportRun(run)) return
    setBusy(true); setError(null); setNotice(''); setAction('Выбираем не исключённые карточки со всех страниц пакета…')
    try {
      const ids = (await allCandidates(run)).filter((candidate) => isSelectableForBulkReview(candidate, run.excludeWithWebsite)).map((candidate) => candidate.candidateId)
      setSelectedIds(new Set(ids))
      setNotice(ids.length ? `Выбрано карточек: ${ids.length} во всём пакете. Нажмите «Включить выбранные».` : 'В пакете нет подходящих не исключённых карточек.')
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false); setAction('') }
  }

  const includeAllEligible = async () => {
    if (!run) return
    setBusy(true); setError(null); setNotice(''); setAction('Включаем все подходящие карточки в локальном пакете…')
    try {
      const all = await allCandidates(run)
      const ids = all.filter((candidate) => isSelectableForBulkReview(candidate, run.excludeWithWebsite)
        && isEligibleForReview(candidate, run.excludeWithWebsite)).map((candidate) => candidate.candidateId)
      if (!ids.length) throw new Error('Нет подходящих не исключённых карточек.')
      await commitDecision('include', ids)
    } catch (caught) { setError(getErrorMessage(caught)); await refreshSelected(run.id).catch(() => {}) }
    finally { setBusy(false); setAction('') }
  }

  const branchReview = async (groupKey: string, classification: 'independent' | 'confirmed') => {
    if (!run) return
    setBusy(true); setError(null)
    try { await local.reviewBranchGroup(workspaceId, run.id, groupKey, classification); await refreshSelected(run.id) }
    catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const allCandidates = async (target: ImportRun): Promise<ImportCandidate[]> => {
    const all: ImportCandidate[] = []
    for (let page = 0; ; page += 1) {
      const result = await local.listCandidates(workspaceId, target.id, page, 100, '')
      all.push(...result.items)
      if (!result.items.length || all.length >= result.total) break
    }
    return all
  }

  const showPublishPreview = async () => {
    if (!run) return
    setBusy(true); setError(null)
    try {
      const all = await allCandidates(run)
      const ready = all.filter((candidate) => candidate.userDecision === 'include' && candidate.importStatus === 'ready')
      if (!ready.length) throw new Error('Нет готовых карточек с явным решением «включить».')
      const excluded = Math.max(0, run.rawFound - all.length) + countExcludedCandidates(all)
      const result = await previewLocalImportPublication(client, workspaceId, run.source, ready, excluded, run.excludeWithWebsite)
      setPublishCandidates(ready); setPreview(result); setConfirmPublish(true)
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const publish = async () => {
    if (!run) return
    setBusy(true); setError(null); setAction('Повторная проверка и публикация подтверждённых карточек…')
    try {
      const currentRun = await local.getRun(workspaceId, run.id)
      if (!currentRun) throw new Error('Локальный пакет не найден.')
      const current = await allCandidates(currentRun)
      const ids = new Set(publishCandidates.map((candidate) => candidate.candidateId))
      const selected = current.filter((candidate) => ids.has(candidate.candidateId))
      if (selected.length !== ids.size || selected.some((candidate) => !isEligibleForReview(candidate, currentRun.excludeWithWebsite)
        || candidate.userDecision !== 'include' || candidate.importStatus !== 'ready')) {
        throw new Error('Карточки изменились после предварительного отчёта. Проверьте найденные сайты, ошибки данных и решения о включении.')
      }
      const key = await local.preparePublication(workspaceId, run.id)
      const excluded = Math.max(0, currentRun.rawFound - current.length) + countExcludedCandidates(current)
      const report = await publishLocalImportCandidates(client, workspaceId, currentRun.source, key, selected, excluded, currentRun.excludeWithWebsite)
      const updated = await local.recordPublication(workspaceId, run.id, report)
      setRun(updated); setConfirmPublish(false); setPreview(null)
      await refreshSelected(run.id, 0)
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false); setAction('') }
  }

  const retryFailedPublication = async () => {
    if (!run) return
    setBusy(true); setError(null)
    try {
      await local.preparePublication(workspaceId, run.id)
      const restored = await local.getRun(workspaceId, run.id)
      if (!restored) throw new Error('Локальный пакет не найден.')
      setRun(restored)
      const all = await allCandidates(restored)
      const ready = all.filter((candidate) => candidate.userDecision === 'include' && candidate.importStatus === 'ready')
      if (!ready.length) throw new Error('Нет неудачных карточек, прошедших повторную локальную проверку.')
      const excluded = Math.max(0, restored.rawFound - all.length) + countExcludedCandidates(all)
      const result = await previewLocalImportPublication(client, workspaceId, restored.source, ready, excluded, restored.excludeWithWebsite)
      setPublishCandidates(ready); setPreview(result); setConfirmPublish(true)
      await refreshSelected(run.id, 0)
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const exportCsv = async (filtered = false) => {
    if (!run) return
    try {
      const all = filtered ? await allCandidates(run) : candidates
      const rows = filtered && search ? all.filter((candidate) => [candidate.companyName, candidate.city, candidate.address, candidate.phone]
        .some((value) => value?.toLocaleLowerCase('ru-RU').includes(search.toLocaleLowerCase('ru-RU')))) : all
      downloadCsv(importCandidatesToCsv(rows), `${safeFilePart(run.city)}-${safeFilePart(run.niche)}-import.csv`)
    } catch (caught) { setError(getErrorMessage(caught)) }
  }

  const openEditor = (candidate: ImportCandidate) => {
    setEditing(candidate)
    setFields({ companyName: candidate.companyName, city: candidate.city, address: candidate.address ?? '', niche: candidate.niche,
      phone: candidate.phone ?? '', website: candidate.website ?? '' })
  }
  const saveEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!run || !fields) return
    setBusy(true); setError(null)
    try {
      if (editing) await local.editCandidate(workspaceId, run.id, editing.candidateId, fields)
      else await local.addCandidate(workspaceId, run.id, fields)
      setEditing(null); setFields(null)
      await refreshSelected(run.id)
    }
    catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const reject = async () => {
    if (!run || !window.confirm('Отклонить весь пакет? Лиды в общей CRM не изменятся.')) return
    setBusy(true); setError(null)
    try {
      const updated = await local.rejectRun(workspaceId, run.id)
      setRun(updated); await loadRuns(updated.id)
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const remove = async (target = run) => {
    if (!target || !isDeletableRun(target) || !window.confirm('Удалить этот локальный пакет и его карточки с этого компьютера?')) return
    setBusy(true); setError(null)
    try {
      await local.deleteRun(workspaceId, target.id)
      if (run?.id === target.id) { setRun(null); setCandidates([]); setCandidateTotal(0) }
      await loadRuns()
    }
    catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }

  const branchGroups = useMemo(() => [...new Map(candidates.filter((candidate) => candidate.branchGroupKey)
    .map((candidate) => [candidate.branchGroupKey!, candidate])).values()], [candidates])

  const canReview = Boolean(run && isReviewableImportRun(run))

  return <div className="page parser-page">
    <div className="page-heading">
      <div><div className="parser-eyebrow"><MapIcon /> Импорт компаний · локальный сбор</div><h1>Парсер</h1>
        <p>Черновые карточки хранятся на этом компьютере до вашего подтверждения</p></div>
      <span className={`parser-stage ${connected ? 'is-connected' : ''}`}>{connected ? 'Локально подключён' : 'Нужен локальный процесс'}</span>
    </div>

    {!connected && <section className="parser-panel" aria-labelledby="parser-connection-title">
      <div className="parser-panel-heading"><div className="parser-panel-icon"><ShieldCheck /></div><div><h2 id="parser-connection-title">Подключить локальный сборщик</h2>
        <p>Запустите Node.js процесс на этом компьютере и введите одноразовый токен из терминала</p></div></div>
      <form className="parser-connect-form" onSubmit={(event) => void connect(event)}>
        <label className="field"><span>Одноразовый токен подключения</span><input value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
        <button className="button primary" disabled={busy}><ShieldCheck /> Подключить</button>
      </form>
      <p className="parser-note"><Info /> Процесс открывает видимое окно браузера, слушает только локальный компьютер и не получает пароль, токен или ключ Supabase.</p>
    </section>}

    {connected && <>
      <section className="parser-panel" aria-labelledby="parser-settings-title">
        <div className="parser-panel-heading"><div className="parser-panel-icon"><MapIcon /></div><div><h2 id="parser-settings-title">Новый поиск</h2><p>Источник: 2ГИС · браузер запускается локально</p></div></div>
        <form onSubmit={(event) => void start(event)}>
          <div className="parser-form-grid">
            <label className="field"><span>Город *</span><input value={city} onChange={(event) => setCity(event.target.value)} maxLength={200} placeholder="Например, Казань" required /></label>
            <label className="field"><span>Ниша *</span><input list="crm-niches" value={niche} onChange={(event) => setNiche(event.target.value)} maxLength={200} placeholder="Например, стоматология" required />
              <datalist id="crm-niches">{existingNiches.map((value) => <option key={value} value={value} />)}</datalist></label>
            <label className="field"><span>Желаемое число карточек</span><input type="number" min={0} max={5000} step={1} value={requestedCount} onChange={(event) => setRequestedCount(event.target.value)} required />
              <small>0 собирает до конца выдачи. Технический предел запуска — 5000 карточек и 200 страниц.</small></label>
          </div>
          <label className="check-field"><input type="checkbox" checked={excludeWithWebsite}
            onChange={(event) => setExcludeWithWebsite(event.target.checked)} /> Исключать, если есть сайт</label>
          <p className="parser-note"><Info /> Непроверенные карточки можно включить вручную. Если найдено больше двух разных карточек с одним названием, вся группа исключается.</p>
          <div className="parser-run-row"><p className="parser-note"><Info /> Страницы переключаются автоматически. При зависании сборщик перезапускается, результаты обновляются каждые 20 секунд. CAPTCHA требует ручного решения.</p>
            <button className="button primary" disabled={busy || runs.some((item) => item.status === 'collecting') || !city.trim() || !niche.trim()}><Play /> Запустить локально</button></div>
        </form>
      </section>

      <section className="parser-results" aria-labelledby="local-runs-title">
        <div className="parser-results-heading"><h2 id="local-runs-title">Локальные пакеты</h2><button className="icon-button" title="Обновить" disabled={busy} onClick={() => void loadRuns()}><RefreshCw /></button></div>
        {!runs.length ? <div className="empty-state parser-empty"><div><Building2 /></div><h3>Пакетов пока нет</h3><p>Запустите поиск, чтобы создать локальный пакет проверки.</p></div> :
          <div className="import-run-list">{runs.map((item) => <div key={item.id} className={`import-run-row ${run?.id === item.id ? 'active' : ''}`}>
            <button type="button" className="import-run-select" onClick={() => void selectRun(item)}>
              <span><strong>{item.niche} · {item.city}</strong><small>{statusLabel(item)} · {item.rawFound} исходных карточек · {new Date(item.startedAt ?? item.finishedAt ?? Date.now()).toLocaleString('ru-RU')}</small></span>
              <span className="parser-count">{item.readyCount} готовы</span></button>
            {isDeletableRun(item) && <button type="button" className="icon-button import-run-delete" title="Удалить локальный пакет" aria-label={`Удалить пакет ${item.niche} — ${item.city}`}
              disabled={busy || autoCollecting} onClick={() => void remove(item)}><Trash2 /></button>}
          </div>)}</div>}
      </section>

      {run && <section className="parser-results" aria-labelledby="run-review-title">
        <div className="parser-results-heading"><div><h2 id="run-review-title">{run.niche} — {run.city}</h2>
          <p className="muted">{statusLabel(run)} · {run.excludeWithWebsite === false ? 'сайты разрешены' : 'сайты исключаются'}{run.completeness === 'partial' ? ' · результат частичный' : ''}</p></div>
          <div className="parser-toolbar">
            {['collecting', 'needs_attention', 'partially_completed'].includes(run.status) && run.publicationStatus === 'not_started' &&
              <button className="button secondary" disabled={busy} onClick={() => void runCollectionAction('cancel')}><StopCircle /> Остановить</button>}
            {((run.status === 'partially_completed' && ['page_limit_reached', 'candidate_limit_reached', 'visible_results_exhausted'].includes(run.stopReason ?? ''))
              || (run.status === 'needs_attention' && ['local_process_restarted', 'captcha_manual', 'source_error', 'browser_start_failed', 'browser_closed', 'resume_failed', 'page_layout_changed'].includes(run.stopReason ?? ''))) &&
              <button className="button secondary" disabled={busy} onClick={() => void runCollectionAction('continue')}><RefreshCw />
                {run.status === 'needs_attention' && run.stopReason === 'captcha_manual' ? 'Проверить CAPTCHA и продолжить'
                  : run.stopReason === 'visible_results_exhausted' ? 'Повторить загрузку' : 'Продолжить с лимитом'}</button>}
            {run.status === 'partially_completed' && run.publicationStatus === 'partially_completed' && <button className="button secondary" disabled={busy} onClick={() => void retryFailedPublication()}><RefreshCw /> Повторить ошибки публикации</button>}
            {canReview && !autoCollecting && <button className="button secondary" disabled={busy} onClick={() => void reject()}><X /> Отклонить пакет</button>}
            {canReview && <button className="button secondary" disabled={busy} onClick={() => {
              setEditing(null)
              setFields({ companyName: '', city: run.city, niche: run.niche, address: '', phone: '', website: '' })
            }}>Добавить карточку</button>}
            {isDeletableRun(run) && <button className="button danger-button" disabled={busy || autoCollecting} onClick={() => void remove()}><Trash2 /> Удалить локально</button>}
          </div>
        </div>
        {(run.errorMessage || run.stopReason) && <div className={`parser-state-note ${run.status === 'needs_attention' ? 'attention' : ''}`}><AlertTriangle />{run.errorMessage ?? run.stopReason}</div>}
        {run.status === 'collecting' && <div className="parser-progress"><LoaderCircle className="spin" /><span>{action || 'Автоматически собираем результаты. Обновление каждые 20 секунд.'}</span><strong>{run.rawFound} получено</strong></div>}
        {action && <p className="parser-busy-note">{action}</p>}
        {error && <div className="error-box" role="alert">{error}</div>}
        {notice && <div className="parser-state-note" role="status">{notice}</div>}
        <div className="parser-stats-grid">
          <Stat label="Исходных" value={run.rawFound} /><Stat label="Уникальных" value={run.uniqueCount} />
          <Stat label="Точных дубликатов" value={run.exactDuplicateCount} /><Stat label="Вероятных дубликатов" value={run.possibleDuplicateCount} />
          <Stat label="Филиальных групп" value={run.branchGroupCount} /><Stat label="С ошибками" value={run.invalidCount} />
          <Stat label="Требуют проверки" value={run.needsReviewCount} /><Stat label="Готовы к публикации" value={run.readyCount} />
          <Stat label="Исключено" value={run.excludedCount} /><Stat label="Уже в CRM" value={run.existingCount} />
          <Stat label="Импортировано" value={run.importedCount} />
        </div>

        {run.storedCount > 0 && <>
          <div className="parser-review-toolbar">
            <label className="search-box"><Search /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Найти компанию, адрес, телефон" aria-label="Поиск по локальному пакету" />
              <button type="button" onClick={() => { setSearch(searchInput); void loadCandidates(run.id, 0, searchInput) }}>Найти</button></label>
            <button className="button secondary" disabled={busy} onClick={() => void exportCsv(false)}><Download /> CSV страницы</button>
            <button className="button secondary" disabled={busy} onClick={() => void exportCsv(true)}><Download /> CSV пакета</button>
            {canReview && <><button className="button secondary" disabled={busy} onClick={() => void selectAllEligible()}>Выбрать все не исключённые</button>
              <button className="button secondary" disabled={busy} onClick={() => void includeAllEligible()}>Включить все подходящие</button></>}
          </div>
          {canReview && candidates.some((candidate) => isSelectableForBulkReview(candidate, run.excludeWithWebsite)) && <button className="button text parser-select-page" type="button" disabled={busy} onClick={() => setSelectedIds((old) => new Set([...old, ...candidates.filter((candidate) => isSelectableForBulkReview(candidate, run.excludeWithWebsite)).map((candidate) => candidate.candidateId)]))}>Выбрать подходящие на странице</button>}
          {canReview && selectedIds.size > 0 && <div className="parser-selection-bar"><span>Выбрано: {selectedIds.size} во всём пакете</span>
            <button className="button text" disabled={busy} onClick={() => setSelectedIds(new Set())}>Снять галочки</button>
            <button className="button secondary" disabled={busy} onClick={() => void decide('include')}><Check /> Включить выбранные</button>
            <button className="button secondary" disabled={busy} onClick={() => void decide('exclude')}><X /> Исключить выбранные</button>
          </div>}
          {branchGroups.length > 0 && <div className="branch-review-list"><strong>Группы, найденные на странице</strong>{branchGroups.map((member) => <div key={member.branchGroupKey}>
            <span>{Math.max(0, (member.branchGroupKey?.split(':').length ?? 1) - 1)} карточки · {member.branchEvidence.join(' ')}</span>
            <button type="button" disabled={busy || !canReview} onClick={() => void branchReview(member.branchGroupKey!, 'independent')}>Независимые</button>
            <button type="button" disabled={busy || !canReview} onClick={() => void branchReview(member.branchGroupKey!, 'confirmed')}>Филиальная сеть</button>
          </div>)}</div>}
          <div className="candidate-list">{candidates.map((candidate) => <article className="candidate-row" key={candidate.candidateId}>
            <button type="button" className="candidate-select" disabled={busy || !canReview || (run.excludeWithWebsite !== false && hasCandidateWebsite(candidate)) || ['imported', 'skipped_existing'].includes(candidate.importStatus)} aria-pressed={selectedIds.has(candidate.candidateId)} aria-label={`Выбрать ${candidate.companyName}`} onClick={() => setSelectedIds((old) => {
              const next = new Set(old); next.has(candidate.candidateId) ? next.delete(candidate.candidateId) : next.add(candidate.candidateId); return next
            })}>{selectedIds.has(candidate.candidateId) ? <Check /> : <Square />}</button>
            <div className="candidate-main"><div><strong>{candidate.companyName}</strong><span className={`candidate-badge ${candidate.importStatus}`}>{candidateStatus(candidate, run.excludeWithWebsite)}</span></div>
              <p>{candidate.city}{candidate.address ? ` · ${candidate.address}` : ''}</p><p>{candidate.phone ?? 'Телефон не указан'}</p>
              <p className="candidate-website">Сайт: {candidateWebsiteUrl(candidate)
                ? <a href={candidateWebsiteUrl(candidate)!} target="_blank" rel="noreferrer">{candidate.website}</a>
                : candidate.website || (hasCurrentNoWebsiteCheck(candidate) ? 'Не указан в контактах 2ГИС — проверено'
                  : candidate.websiteCheckStatus === 'present' ? 'Адрес сайта не получен' : 'Не указан — проверка не завершена')}</p>
              {candidate.validationErrors.length > 0 && <p className="candidate-warning">{candidate.validationErrors.join(' ')}</p>}
              {candidate.exclusionReason && <p className="candidate-warning">{candidate.exclusionReason}</p>}
              {candidate.branchEvidence.length > 0 && <p className="candidate-warning">{candidate.branchEvidence.join(' ')}</p>}
              {candidate.duplicateOfId && <p className="candidate-warning">Дубликат карточки {candidate.duplicateOfId.slice(0, 8)}</p>}
            </div>
            <div className="candidate-actions">{candidate.sourceUrl && <a href={candidate.sourceUrl} target="_blank" rel="noreferrer" title="Открыть исходную карточку"><ExternalLink /></a>}
              <button type="button" disabled={busy || !canReview} onClick={() => openEditor(candidate)}>Править</button>
              {candidate.userDecision !== 'include' && <button type="button" disabled={busy || !canReview || !isEligibleForReview(candidate, run.excludeWithWebsite)} onClick={() => void decide('include', [candidate.candidateId])}>Включить</button>}
              {candidate.userDecision !== 'exclude' && <button type="button" disabled={busy || !canReview} onClick={() => void decide('exclude', [candidate.candidateId])}>Исключить</button>}
            </div>
          </article>)}</div>
          <div className="parser-pagination"><span>{candidateTotal} карточек · страница {candidatePage + 1} из {Math.max(1, Math.ceil(candidateTotal / pageSize))}</span>
            <button className="button secondary" disabled={busy || candidatePage === 0} onClick={() => void loadCandidates(run.id, candidatePage - 1)}>Назад</button>
            <button className="button secondary" disabled={busy || (candidatePage + 1) * pageSize >= candidateTotal} onClick={() => void loadCandidates(run.id, candidatePage + 1)}>Дальше</button>
          </div>
        </>}
        {candidateTotal === 0 && run.storedCount > 0 && <p className="muted parser-empty-filter">На этой странице ничего нет для выбранного фильтра.</p>}
        {run.readyCount > 0 && canReview && !autoCollecting && <div className="publish-strip"><p><ShieldCheck /> До подтверждения карточки находятся только в локальном SQLite.</p>
          <button className="button primary" disabled={busy} onClick={() => void showPublishPreview()}>Проверить публикацию · {run.readyCount}</button></div>}
      </section>}
    </>}

    {error && (!run || !connected) && <div className="error-box page-error" role="alert">{error}</div>}
    {fields && <div className="modal-backdrop"><section className="modal form-modal" role="dialog" aria-modal="true" aria-labelledby="candidate-edit-title">
      <button className="modal-close" disabled={busy} onClick={() => { setEditing(null); setFields(null) }} aria-label="Закрыть"><X /></button>
      <h2 id="candidate-edit-title">{editing ? 'Проверить карточку' : 'Добавить карточку'}</h2><p>Изменения сохраняются в локальном пакете.</p>
      {error && <div className="error-box" role="alert">{error}</div>}
      <form className="lead-form" onSubmit={(event) => void saveEdit(event)}>
        <EditField label="Название" value={fields.companyName} set={(value) => setFields({ ...fields, companyName: value })} />
        <EditField label="Город" value={fields.city} set={(value) => setFields({ ...fields, city: value })} />
        <EditField label="Адрес" value={fields.address} set={(value) => setFields({ ...fields, address: value })} />
        <EditField label="Ниша" value={fields.niche} set={(value) => setFields({ ...fields, niche: value })} />
        <EditField label="Телефон" value={fields.phone} set={(value) => setFields({ ...fields, phone: value })} />
        <EditField label="Сайт" value={fields.website} set={(value) => setFields({ ...fields, website: value })} />
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => { setEditing(null); setFields(null) }}>Отмена</button><button className="button primary" disabled={busy}>Сохранить локально</button></div>
      </form>
    </section></div>}
    {confirmPublish && preview && <div className="modal-backdrop"><section className="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title">
      <button className="modal-close" disabled={busy} onClick={() => setConfirmPublish(false)} aria-label="Закрыть"><X /></button>
      <div className="modal-icon"><ShieldCheck /></div><h2 id="publish-confirm-title">Подтвердить публикацию?</h2>
      <p>Будут созданы лиды в общей базе только для выбранных карточек. Существующие лиды не изменяются.</p>
      <div className="publish-report"><span>Будет создано<strong>{preview.toCreate}</strong></span><span>Уже есть в CRM<strong>{preview.alreadyExists}</strong></span><span>Исключено из пакета<strong>{preview.excluded}</strong></span></div>
      <p className="muted">Проверка повторится на сервере при публикации. Локальная копия пакета сохранится.</p>
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmPublish(false)}>Назад к проверке</button>
        <button className="button primary" disabled={busy || preview.toCreate + preview.alreadyExists === 0} onClick={() => void publish()}>{busy ? 'Публикуем…' : 'Подтвердить и опубликовать'}</button></div>
    </section></div>}
  </div>
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="parser-stat"><span>{label}</span><strong>{value}</strong></div>
}

function EditField({ label, value, set }: { label: string; value: string; set: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input value={value} maxLength={label === 'Название' ? 300 : label === 'Адрес' ? 500 : 200} onChange={(event) => set(event.target.value)} /></label>
}

function statusLabel(run: ImportRun): string {
  const labels: Record<ImportRun['status'], string> = {
    created: 'Создан', collecting: 'Собирает', ready_for_review: 'Готов к проверке', approved: 'Подтверждён',
    importing: 'Публикуется', completed: 'Завершён', cancelled: 'Сбор остановлен', failed: 'Ошибка', needs_attention: 'Нужно внимание',
    partially_completed: 'Завершён частично', rejected: 'Отклонён',
  }
  return labels[run.status]
}

function isDeletableRun(run: ImportRun): boolean {
  return run.publicationStatus === 'not_started'
    && ['ready_for_review', 'partially_completed', 'needs_attention', 'cancelled', 'rejected', 'failed'].includes(run.status)
}
function candidateStatus(candidate: ImportCandidate, excludeWithWebsite = true): string {
  if (candidate.importStatus === 'imported') return 'Импортировано'
  if (candidate.importStatus === 'skipped_existing') return 'Уже в CRM'
  if (candidate.importStatus === 'failed') return 'Ошибка импорта'
  if (excludeWithWebsite && hasCandidateWebsite(candidate)) return 'Исключена: есть сайт'
  if (candidate.duplicateKind === 'exact') return 'Точный дубль'
  if (candidate.branchClassification === 'confirmed' && candidate.branchOverride !== 'independent') return 'Филиальная группа'
  if (candidate.branchClassification === 'needs_review' && candidate.branchOverride !== 'independent') return 'Нужна проверка'
  if (candidate.validationErrors.length) return 'Ошибка данных'
  if (candidate.userDecision === 'exclude') return 'Исключена'
  if (candidate.importStatus === 'ready') return 'Готова'
  return candidate.userDecision === 'include' ? 'Выбрана'
    : (hasCurrentNoWebsiteCheck(candidate) || hasCandidateWebsite(candidate)) ? 'Ожидает решения' : 'Не проверена'
}
function candidateWebsiteUrl(candidate: ImportCandidate): string | null {
  const website = candidate.website?.trim()
  return website && normalizeDomain(website) ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null
}
function safeFilePart(value: string): string { return value.toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'import' }
function countExcludedCandidates(candidates: ImportCandidate[]): number {
  return candidates.filter((candidate) => candidate.userDecision === 'exclude').length
}
function downloadCsv(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url)
}
