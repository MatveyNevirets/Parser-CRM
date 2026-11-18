import { useEffect, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowRight, Copy, Download, ExternalLink, Mic, Square, X } from 'lucide-react'
import { useCallRecorder } from '../hooks/useCallRecorder'
import { useLeadHistory } from '../hooks/useLeadHistory'
import { getErrorMessage, withTimeout } from '../lib/errors'
import {
  audioExtensions, callOutcomes, decodeAudio, encodeAudio, formatDate, formatDuration,
  readAudioFile, toLocalInput, type CallAudio, type CallOutcome, type LeadCall,
} from '../lib/sales'
import { statusLabels, type Lead } from '../types'

const audioAccept = '.webm,.ogg,.oga,.m4a,.mp4,.wav,.mp3,audio/*'

function newDraft() {
  return { id: crypto.randomUUID(), occurredAt: toLocalInput(new Date().toISOString(), true),
    outcome: '' as CallOutcome | '', well: '', poorly: '', notes: '' }
}

function twoGisLink(lead: Lead) {
  const source = lead.source_url?.trim()
  if (source && /^https:\/\/(?:www\.)?2gis\.ru\/(?:[^/?#]+\/)*firm\/\d+(?:[/?#]|$)/i.test(source)) {
    return { href: source, label: 'Открыть в 2ГИС' }
  }
  const query = [lead.company_name, lead.city, lead.address].map((part) => part?.trim()).filter(Boolean).join(' ')
  return { href: `https://2gis.ru/search/${encodeURIComponent(query)}`, label: 'Найти в 2ГИС' }
}

export function CallDialog({ client, lead, onClose, onNext, onReturnToAll, historyOnly = false }: {
  client: SupabaseClient; lead: Lead; onClose: () => void; onNext?: () => void
  onReturnToAll?: (lead: Lead) => Promise<void>; historyOnly?: boolean
}) {
  const history = useLeadHistory<LeadCall>(client, 'lead_calls', lead.id)
  const [draft, setDraft] = useState(newDraft)
  const [audio, setAudio] = useState<CallAudio | null>(null)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const audioUrl = useAudioUrl(audio?.blob)
  const recorder = useCallRecorder((recorded, limitReached) => {
    setAudio(recorded)
    setNotice(limitReached ? 'Достигнут лимит размера. Запись остановлена и готова к сохранению.' : 'Запись готова к прослушиванию.')
  })
  const hasContent = Boolean(draft.outcome || draft.well.trim() || draft.poorly.trim() || draft.notes.trim() || audio)
  const locked = busy || reading || recorder.state !== 'idle'
  const unsaved = hasContent || locked
  const twoGis = twoGisLink(lead)

  useEffect(() => {
    if (!unsaved) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [unsaved])

  const close = () => {
    if (busy || reading || recorder.state === 'finishing') return
    if (!unsaved || window.confirm('Закрыть окно и сбросить несохранённые данные звонка?')) onClose()
  }

  const copy = async () => {
    if (!lead.phone) return
    try { await navigator.clipboard.writeText(lead.phone); setCopyStatus('Номер скопирован.') }
    catch { setCopyStatus('Не удалось скопировать номер. Выделите его и скопируйте вручную.') }
  }

  const upload = async (file: File) => {
    setReading(true); setError(''); setNotice('')
    try { setAudio(await readAudioFile(file)); setNotice('Файл готов к сохранению.') }
    catch (failure) { setError(getErrorMessage(failure)) }
    finally { setReading(false) }
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')
    if (locked || (!hasContent && action !== 'return')) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (hasContent) {
        const { error: failure } = await withTimeout(client.rpc('save_lead_call', {
          p_lead_id: lead.id, p_id: draft.id, p_occurred_at: new Date(draft.occurredAt).toISOString(),
          p_outcome: draft.outcome || null, p_went_well: draft.well.trim(), p_went_poorly: draft.poorly.trim(), p_notes: draft.notes.trim(),
          p_audio_mime: audio?.mime ?? null, p_audio_duration: audio?.duration ?? null,
          p_audio_base64: audio ? await encodeAudio(audio.blob) : null,
        }), 60_000)
        if (failure) throw failure
        setDraft(newDraft()); setAudio(null); setNotice('Звонок сохранён.'); history.refresh()
      }
      if (action === 'next' && onNext) onNext()
      if (action === 'return' && onReturnToAll) await onReturnToAll(lead)
    } catch (failure) { setError(getErrorMessage(failure)) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section className="modal form-modal call-modal" role="dialog" aria-modal="true" aria-labelledby="call-dialog-title">
      <button className="modal-close" aria-label="Закрыть" disabled={busy || reading || recorder.state === 'finishing'} onClick={close}><X /></button>
      <h2 id="call-dialog-title">{lead.company_name}</h2>
      <p className="muted">{[lead.niche, lead.city, lead.address, statusLabels[lead.status]].filter(Boolean).join(' · ')}</p>
      <div className="call-contact">
        {!historyOnly && <>
          <strong>{lead.phone || 'Телефон не указан'}</strong>
          <button className="button secondary" disabled={!lead.phone} onClick={() => void copy()}><Copy /> Копировать номер</button>
        </>}
        <a className="button secondary" href={twoGis.href} target="_blank" rel="noopener noreferrer"><ExternalLink /> {twoGis.label}</a>
        {copyStatus && <small role="status">{copyStatus}</small>}
      </div>
      {!historyOnly && lead.notes && <details className="lead-call-notes"><summary>Заметки о компании</summary><p>{lead.notes}</p></details>}
      {!historyOnly && <form className="lead-form" onSubmit={(event) => void save(event)}>
        <div className="form-grid">
          <label className="field"><span>Результат звонка</span><select value={draft.outcome} disabled={busy}
            onChange={(event) => setDraft({ ...draft, outcome: event.target.value as CallOutcome | '' })}>
            <option value="">Не указан</option>{Object.entries(callOutcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="field"><span>Дата и время</span><input type="datetime-local" step="1" required value={draft.occurredAt} disabled={busy}
            onChange={(event) => setDraft({ ...draft, occurredAt: event.target.value })} /></label>
        </div>
        <div className="activity-section audio-section">
          <h3>Аудиозапись</h3>
          <div className="activity-actions">
            {recorder.state === 'recording' ? <>
              <span className="recording-status" role="status"><i /> Идёт запись <strong>{formatDuration(recorder.seconds)}</strong></span>
              <button className="button danger-button" type="button" onClick={recorder.stop}><Square /> Остановить запись</button>
            </> : !audio && <button className="button secondary" type="button" disabled={locked} onClick={() => {
              setNotice(''); setError(''); void recorder.start()
            }}><Mic /> {recorder.state === 'permission' ? 'Ожидаем доступ к микрофону…'
              : recorder.state === 'finishing' ? 'Готовим запись…' : 'Начать запись'}</button>}
            {!audio && <label className="field file-field"><span>Загрузить аудио</span><input type="file" accept={audioAccept} disabled={locked}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void upload(file)
              }} /></label>}
          </div>
          {reading && <p role="status">Проверяем аудиофайл…</p>}
          {recorder.error && <div className="error-box" role="alert">{recorder.error}</div>}
          {audio && audioUrl ? <div className="audio-preview">
            <audio controls src={audioUrl} aria-label="Предпросмотр записи" />
            <div className="activity-actions">
              <a href={audioUrl} className="button secondary" download={`call.${audioExtensions[audio.mime]}`}><Download /> Скачать</a>
              <button className="button text" type="button" disabled={busy} onClick={() => {
                if (window.confirm('Убрать несохранённую аудиозапись из формы?')) {
                  setAudio(null); setNotice('')
                }
              }}>Убрать запись</button>
            </div>
          </div> : <p>Микрофон записывает звук вокруг устройства. Поддерживаемые файлы — до 8 МБ.</p>}
        </div>
        <div className="form-grid">
          <CallNote label="Что было хорошо" value={draft.well} disabled={busy} onChange={(value) => setDraft({ ...draft, well: value })} />
          <CallNote label="Что было плохо" value={draft.poorly} disabled={busy} onChange={(value) => setDraft({ ...draft, poorly: value })} />
        </div>
        <CallNote label="Общие заметки" value={draft.notes} disabled={busy} onChange={(value) => setDraft({ ...draft, notes: value })} />
        {notice && <p className="success-note" role="status">{notice}</p>}
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="modal-actions">
          {onNext && !unsaved && <button className="button secondary" type="button" onClick={onNext}>Следующий лид <ArrowRight /></button>}
          <button className="button primary" disabled={locked || !hasContent}>{busy ? 'Сохраняем…' : 'Сохранить звонок'}</button>
          {onNext && hasContent && <button className="button secondary" value="next" disabled={locked}>Сохранить и дальше <ArrowRight /></button>}
          {onReturnToAll && <button className="button secondary" value="return" disabled={locked} formNoValidate={!hasContent}>Вернуть в общее</button>}
        </div>
      </form>}
      <section className="activity-section call-history">
        <h3>История звонков</h3>
        {history.error ? <div className="error-box" role="alert">{history.error} <button className="button text" onClick={history.refresh}>Обновить историю</button></div>
          : !history.rows ? <p>Загружаем историю…</p>
            : !history.rows.length ? <p>Звонков пока нет.</p>
              : history.rows.map((call) => <CallHistoryItem key={call.id} client={client} call={call} refresh={history.refresh} />)}
        {history.more && <button className="button text" disabled={history.loadingMore} onClick={history.loadMore}>Показать ещё звонки</button>}
      </section>
    </section>
  </div>
}

function CallNote({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean
}) {
  return <label className="field"><span>{label}</span><textarea rows={2} maxLength={10000} disabled={disabled}
    value={value} onChange={(event) => onChange(event.target.value)} /></label>
}

function CallHistoryItem({ client, call, refresh }: { client: SupabaseClient; call: LeadCall; refresh: () => void }) {
  const [audio, setAudio] = useState<Blob>()
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const url = useAudioUrl(audio)

  const listen = async () => {
    if (!call.audio_mime) return
    setBusy(true); setError('')
    try {
      const { data, error: failure } = await withTimeout(client.rpc('get_lead_call_audio', { p_call_id: call.id }), 45_000)
      if (failure) throw failure
      if (!data) throw new Error('Запись недоступна.')
      setAudio(decodeAudio(data as string, call.audio_mime))
    } catch (failure) { setError(getErrorMessage(failure)) }
    finally { setBusy(false) }
  }

  const attach = async (selected: File) => {
    setBusy(true); setError(''); setFile(selected)
    try {
      const attached = await readAudioFile(selected)
      const { error: failure } = await withTimeout(client.rpc('attach_lead_call_audio', {
        p_call_id: call.id, p_mime: attached.mime, p_duration: attached.duration, p_base64: await encodeAudio(attached.blob),
      }), 60_000)
      if (failure) throw failure
      setFile(undefined); setAudio(attached.blob); setNotice('Аудио прикреплено.'); refresh()
    } catch (failure) { setError(getErrorMessage(failure)) }
    finally { setBusy(false) }
  }

  return <article className="call-history-item">
    <div className="history-heading"><strong>{call.outcome ? callOutcomes[call.outcome] : 'Без результата'}</strong>
      <time dateTime={call.occurred_at}>{formatDate(call.occurred_at)}</time>
      {call.audio_duration_seconds !== null && <span>Аудио {formatDuration(call.audio_duration_seconds)}</span>}
    </div>
    <dl>{([['Что было хорошо', call.went_well], ['Что было плохо', call.went_poorly], ['Общие заметки', call.notes]]).filter(([, note]) => note)
      .map(([label, note]) => <div key={label}><dt>{label}</dt><dd>{note}</dd></div>)}</dl>
    {call.audio_mime ? url ? <div className="audio-preview">
      <audio controls src={url} aria-label="Сохранённая запись звонка" />
      <a className="button secondary" href={url} download={`call-${call.id}.${audioExtensions[call.audio_mime]}`}><Download /> Скачать запись</a>
    </div> : <button className="button secondary" disabled={busy} onClick={() => void listen()}>
      {busy ? 'Загружаем…' : 'Открыть запись'}</button>
      : <div className="activity-actions">
        <label className="field file-field"><span>Прикрепить аудио</span><input type="file" accept={audioAccept} disabled={busy}
          onChange={(event) => {
            const selected = event.target.files?.[0]
            event.target.value = ''
            if (selected) void attach(selected)
          }} /></label>
        {file && !busy && <button className="button secondary" onClick={() => void attach(file)}>Повторить загрузку</button>}
        {busy && <span role="status">Загружаем аудио…</span>}
      </div>}
    {error && <div className="error-box" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
  </article>
}

function useAudioUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!blob) { setUrl(undefined); return }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}
