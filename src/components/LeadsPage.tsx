import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArchiveRestore, Building2, CloudOff, ExternalLink, Eye, Pencil, Phone, Plus, RefreshCw, Search, Send, Trash2, X } from 'lucide-react'
import { getErrorMessage, withTimeout } from '../lib/errors'
import { hasLeadWebsite } from '../lib/leadWebsite'
import { formatDate, telegramPhone, toLocalInput } from '../lib/sales'
import type { Lead, LeadDraft, LeadPriority, LeadStatus, WebsiteStatus } from '../types'
import { isCallLead, leadPriorities, leadStatuses, priorityLabels, statusLabels, websiteStatuses, websiteStatusLabels } from '../types'
import type { useLeads } from '../hooks/useLeads'
import { CallDialog } from './CallDialog'
import { OutreachHistory } from './OutreachHistory'

type LeadsProps = ReturnType<typeof useLeads> & { client: SupabaseClient; archive?: boolean }

export function LeadsPage(props: LeadsProps) {
  const [tab, setTab] = useState<'all' | 'mailing' | 'calls'>('all')
  const view = props.archive ? 'archive' : tab
  const [query, setQuery] = useState('')
  const [savedFilters, setSavedFilters] = useState(readSavedLeadFilters)
  const [mailingFilters, setMailingFilters] = useState(emptyFilters)
  const [callsFilters, setCallsFilters] = useState(emptyFilters)
  const { niche, status, priority, website } = view === 'all' ? savedFilters
    : view === 'mailing' ? mailingFilters : view === 'calls' ? callsFilters : emptyFilters
  const setFilters = view === 'all' ? setSavedFilters : view === 'mailing' ? setMailingFilters : setCallsFilters
  const [editing, setEditing] = useState<Lead | 'new' | null>(null)
  const [viewing, setViewing] = useState<Lead | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [callLead, setCallLead] = useState<{ lead: Lead; historyOnly: boolean } | null>(null)
  const [deleting, setDeleting] = useState<Lead | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const groups = useMemo(() => ({
    all: props.leads.filter((lead) => !lead.archived_at),
    mailing: props.leads.filter(isMailingLead),
    calls: props.leads.filter(isCallLead),
    archive: props.leads.filter((lead) => Boolean(lead.archived_at)),
  }), [props.leads])
  const list = groups[view]
  const niches = useMemo(() => [...new Set(list.map((lead) => lead.niche))].sort(), [list])
  useEffect(() => {
    try { localStorage.setItem('pahota.leads.filters.v1', JSON.stringify(savedFilters)) }
    catch { /* Storage can be unavailable in private or restricted browser contexts. */ }
  }, [savedFilters])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru')
    const digits = /^[+\d\s().-]+$/.test(needle) ? needle.replace(/\D/g, '') : ''
    const normalizedPhone = digits.length >= 10 ? telegramPhone(needle) : null
    return list.filter((lead) =>
      (!needle || lead.company_name.toLocaleLowerCase('ru').includes(needle) || (lead.phone ?? '').includes(needle)
        || (digits.length > 0 && (lead.phone ?? '').replace(/\D/g, '').includes(digits))
        || (normalizedPhone !== null && telegramPhone(lead.phone) === normalizedPhone)) &&
      (!niche || lead.niche === niche) && (!status || lead.status === status) && (!priority || lead.priority === priority) &&
      (!website || hasLeadWebsite(lead) === (website === 'hasWebsite')))
  }, [list, query, niche, status, priority, website])
  const clearFilters = () => { setQuery(''); if (view !== 'archive') setFilters(emptyFilters) }
  const confirmDelete = async () => {
    if (!deleting) return
    setActionBusy(true); setActionError(null)
    try { await props.deleteLead(deleting); setDeleting(null) }
    catch (caught) { setActionError(getErrorMessage(caught)) }
    finally { setActionBusy(false) }
  }
  const runCardAction = async (action: () => Promise<void>, message: string) => {
    setActionBusy(true); setActionError(null); setNotice('')
    try {
      await action()
      setViewing(null); setConfirmArchive(false); setNotice(message)
    } catch (caught) { setActionError(getErrorMessage(caught)) }
    finally { setActionBusy(false) }
  }
  const markMessage = async (lead: Lead, id: string) => {
    const { error } = await withTimeout(props.client.rpc('mark_mailing_message', {
      p_lead_id: lead.id, p_id: id, p_version: lead.version,
    }))
    if (error) throw error
    await props.refresh()
  }
  const open = (lead: Lead) => {
    setActionError(null); setNotice('')
    if (view === 'calls') setCallLead({ lead, historyOnly: false })
    else setViewing(lead)
  }
  const callPosition = callLead ? filtered.findIndex((lead) => lead.id === callLead.lead.id) : -1
  const nextCall = view === 'calls' && callPosition >= 0 ? filtered[callPosition + 1] : undefined
  const openTab = (next: typeof tab) => { setTab(next); setQuery(''); setNotice('') }
  const returnToAll = async (lead: Lead) => {
    await props.updateLead(lead, {
      status: 'newLead',
      manually_queued_for_calls: false,
      excluded_from_automatic_calls: false,
    })
    setCallLead(null)
    openTab('all')
    setNotice('Лид возвращён в общий список.')
  }

  return <div className="page leads-page">
    <div className="page-heading"><div><h1>{props.archive ? 'Архив' : 'Лиды'}</h1>
      <p>{props.archive ? `Архивных лидов · ${list.length}` : `Компании и потенциальные клиенты · ${list.length}`}</p></div>
      {(view === 'all' || view === 'mailing') && <button className="button primary" onClick={() => setEditing('new')}><Plus /> Добавить лид</button>}</div>
    {!props.archive && <div className="lead-tabs" role="group" aria-label="Рабочие списки лидов">
      <button aria-pressed={tab === 'all'} onClick={() => openTab('all')}>
        <Building2 /> Все <span>{props.loading ? '…' : groups.all.length}</span>
      </button>
      <button aria-pressed={tab === 'mailing'} onClick={() => openTab('mailing')}>
        <Send /> Рассылка <span>{props.loading ? '…' : groups.mailing.length}</span>
      </button>
      <button aria-pressed={tab === 'calls'} onClick={() => openTab('calls')}>
        <Phone /> Звонки <span>{props.loading ? '…' : groups.calls.length}</span>
      </button>
    </div>}
    <div className={`connection-strip ${props.realtimeConnected && !props.error ? 'connected' : ''}`}>
      {props.realtimeConnected && !props.error ? <><span className="pulse" />Синхронизация в реальном времени</> : <><CloudOff /> Список может быть неактуален</>}
      <button className="icon-button" title="Обновить список" onClick={() => void props.refresh()}><RefreshCw /></button>
    </div>
    {props.error && <div className="error-box page-error" role="alert">{props.error}</div>}
    {notice && <div className="success-note" role="status">{notice}</div>}
    <div className={view === 'archive' ? 'archive-filters' : 'filters'}>
      <label className="search-box"><Search /><input aria-label="Поиск" placeholder="Поиск по компании или телефону" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      {view !== 'archive' && <>
        <select aria-label="Ниша" value={niche} onChange={(e) => setFilters((old) => ({ ...old, niche: e.target.value }))}><option value="">Все ниши</option>{niches.map((item) => <option key={item}>{item}</option>)}</select>
        <select aria-label="Статус" value={status} onChange={(e) => setFilters((old) => ({ ...old, status: e.target.value as LeadStatus | '' }))}><option value="">Все статусы</option>{leadStatuses.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}</select>
        <select aria-label="Приоритет" value={priority} onChange={(e) => setFilters((old) => ({ ...old, priority: e.target.value as LeadPriority | '' }))}><option value="">Любой приоритет</option>{leadPriorities.map((item) => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select>
        <select aria-label="Сайт" value={website} onChange={(e) => setFilters((old) => ({ ...old, website: e.target.value as SavedLeadFilters['website'] }))}><option value="">Сайт: все</option><option value="hasWebsite">Есть сайт</option><option value="noWebsite">Нет сайта</option></select>
        <button className="button secondary reset-button" onClick={clearFilters}>Сбросить</button>
      </>}
    </div>
    <section className="leads-table">
      {props.loading ? <div className="table-state"><div className="spinner" />Загружаем лиды…</div>
        : !filtered.length ? <div className="empty-state"><div><Building2 /></div><h3>{list.length ? 'Ничего не найдено'
          : view === 'archive' ? 'Архив пуст' : view === 'calls' ? 'Пока нет лидов на прозвон'
            : view === 'mailing' ? 'Пока нет лидов для рассылки' : 'Пока нет лидов'}</h3>
          {list.length ? <button className="button text" onClick={clearFilters}>Сбросить фильтры</button>
            : view === 'calls' ? <p>Здесь появляются отложенные лиды и карточки, добавленные кнопкой «Прозвонить».</p>
              : view === 'mailing' && <p>Для рассылки подходят новые лиды с обычным приоритетом вне очереди звонков.</p>}</div>
        : <><div className="table-head"><span>КОМПАНИЯ</span><span>НИША</span><span>СТАТУС</span><span>ПРИОРИТЕТ</span><span /></div>
          {filtered.map((lead) => <article className="lead-row" key={lead.id}>
            <button className="company-cell" onClick={() => open(lead)}><strong>{lead.company_name}</strong><span>{lead.phone || 'Телефон не указан'}</span></button>
            <span className="niche-cell">{lead.niche}</span><StatusBadge status={lead.status} /><PriorityBadge priority={lead.priority} />
            <div className="row-actions">
              <button title={view === 'calls' ? 'Открыть звонок' : 'Открыть'} onClick={() => open(lead)}>{view === 'calls' ? <Phone /> : <Eye />}</button>
              {view !== 'archive' && <button title="Редактировать" onClick={() => setEditing(lead)}><Pencil /></button>}
              {(view === 'all' || view === 'mailing') && <button className="danger" title="Удалить" onClick={() => { setActionError(null); setDeleting(lead) }}><Trash2 /></button>}
            </div>
          </article>)}</>}
    </section>
    <p className="storage-note">Карточки сохраняются в общей базе после подтверждения сервера.</p>
    {editing && <LeadForm lead={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
      onNotice={setNotice} onAdd={props.addLead} onUpdate={props.updateLead} />}
    {viewing && (confirmArchive ? <ConfirmDialog title="Убрать в архив?"
      text="Убрать эту карточку из рассылки? Она будет перемещена в архив и не появится повторно при парсинге"
      label="Убрать в архив" pendingLabel="Перемещаем…" busy={actionBusy} error={actionError}
      onClose={() => { setConfirmArchive(false); setActionError(null) }}
      onConfirm={() => void runCardAction(() => props.updateLead(viewing, { archived_at: new Date().toISOString() }), 'Лид перемещён в архив.')} />
      : <LeadDetails client={props.client} lead={viewing} busy={actionBusy} error={actionError}
      onClose={() => { setViewing(null); setActionError(null) }}
      onRestore={() => void runCardAction(() => props.updateLead(viewing, { archived_at: null }), 'Лид восстановлен в общем списке.')}
      onArchive={() => { setConfirmArchive(true); setActionError(null) }}
      onQueue={() => void runCardAction(() => props.updateLead(viewing, {
        status: 'waiting', manually_queued_for_calls: true, excluded_from_automatic_calls: false,
      }), 'Лид добавлен в список прозвонов.')}
      onMessage={(id) => void runCardAction(() => markMessage(viewing, id), 'Сообщение отмечено. Лид переведён в работу.')}
      onHistory={() => { setCallLead({ lead: viewing, historyOnly: true }); setViewing(null) }}
      onEdit={() => { setViewing(null); setEditing(viewing) }} />)}
    {callLead && <CallDialog key={callLead.lead.id} client={props.client}
      lead={props.leads.find((lead) => lead.id === callLead.lead.id) ?? callLead.lead}
      historyOnly={callLead.historyOnly} onClose={() => setCallLead(null)}
      onReturnToAll={callLead.historyOnly ? undefined : returnToAll}
      onNext={nextCall ? () => setCallLead({ lead: nextCall, historyOnly: false }) : undefined} />}
    {deleting && <ConfirmDialog title="Удалить лид?" busy={actionBusy} error={actionError}
      text={`«${deleting.company_name}» будет удалён у всех участников команды.`}
      onClose={() => { if (!actionBusy) { setDeleting(null); setActionError(null) } }} onConfirm={() => void confirmDelete()} />}
  </div>
}

function isMailingLead(lead: Lead) {
  return !lead.archived_at && !isCallLead(lead) && lead.status === 'newLead' && lead.priority === 'normal'
}

interface SavedLeadFilters { niche: string; status: LeadStatus | ''; priority: LeadPriority | ''; website: '' | 'hasWebsite' | 'noWebsite' }
const emptyFilters: SavedLeadFilters = { niche: '', status: '', priority: '', website: '' }

function readSavedLeadFilters(): SavedLeadFilters {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('pahota.leads.filters.v1') ?? 'null')
    if (!value || typeof value !== 'object') return emptyFilters
    const saved = value as Record<string, unknown>
    return {
      niche: typeof saved.niche === 'string' && saved.niche.length <= 200 ? saved.niche : '',
      status: typeof saved.status === 'string' && leadStatuses.includes(saved.status as LeadStatus) ? saved.status as LeadStatus : '',
      priority: typeof saved.priority === 'string' && leadPriorities.includes(saved.priority as LeadPriority) ? saved.priority as LeadPriority : '',
      website: saved.website === 'hasWebsite' || saved.website === 'noWebsite' ? saved.website : '',
    }
  } catch { return emptyFilters }
}
function LeadForm({ lead, onNotice, onClose, onAdd, onUpdate }: {
  lead: Lead | null; onNotice: (message: string) => void
  onClose: () => void; onAdd: LeadsProps['addLead']; onUpdate: LeadsProps['updateLead']
}) {
  const [draft, setDraft] = useState<LeadDraft>(() => lead ? toDraft(lead) : emptyDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof LeadDraft>(key: K, value: LeadDraft[K]) => setDraft((old) => ({ ...old, [key]: value }))
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft.company_name.trim() || !draft.niche.trim()) return
    setBusy(true); setError(null)
    const { yandex_maps_url, ...values } = draft
    const clean = { ...values, company_name: draft.company_name.trim(), niche: draft.niche.trim(),
      phone: emptyToNull(draft.phone), website: emptyToNull(draft.website), notes: emptyToNull(draft.notes) }
    try {
      if (lead) await onUpdate(lead, clean)
      else await onAdd(crypto.randomUUID(), { ...clean, yandex_maps_url: emptyToNull(yandex_maps_url) })
      onNotice('Карточка сохранена.')
      onClose()
    } catch (caught) { setError(getErrorMessage(caught)); setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <section className="modal form-modal" role="dialog" aria-modal="true" aria-labelledby="lead-form-title">
      <button className="modal-close" disabled={busy} aria-label="Закрыть" onClick={onClose}><X /></button>
      <h2 id="lead-form-title">{lead ? 'Редактировать лид' : 'Новый лид'}</h2><p className="muted">Заполните карточку компании</p>
      <form className="lead-form" onSubmit={(event) => void save(event)}>
        <FormField label="Название компании *" value={draft.company_name} onChange={(v) => set('company_name', v)} required disabled={busy} />
        <div className="form-grid"><FormField label="Телефон" value={draft.phone ?? ''} onChange={(v) => set('phone', v)} disabled={busy} />
          <FormField label="Ниша *" value={draft.niche} onChange={(v) => set('niche', v)} required disabled={busy} /></div>
        <FormField label="Сайт" value={draft.website ?? ''} onChange={(v) => set('website', v)} placeholder="https://example.com" disabled={busy} />
        {!lead && <FormField label="Ссылка на Яндекс Карты" value={draft.yandex_maps_url ?? ''} onChange={(v) => set('yandex_maps_url', v)} disabled={busy} />}
        <div className="form-grid three"><SelectField label="Статус сайта" value={draft.website_status} disabled={busy} onChange={(v) => set('website_status', v as WebsiteStatus)} options={websiteStatuses.map((v) => [v, websiteStatusLabels[v]])} />
          <SelectField label="Статус лида" value={draft.status} disabled={busy} onChange={(v) => set('status', v as LeadStatus)}
            options={leadStatuses.map((v) => [v, statusLabels[v]])} />
          <SelectField label="Приоритет" value={draft.priority} disabled={busy} onChange={(v) => set('priority', v as LeadPriority)} options={leadPriorities.map((v) => [v, priorityLabels[v]])} /></div>
        <FormField label="Следующее действие" type="datetime-local" value={toLocalInput(draft.next_action_at)} onChange={(v) => set('next_action_at', v ? new Date(v).toISOString() : null)} disabled={busy} />
        <label className="field"><span>Заметки</span><textarea rows={4} value={draft.notes ?? ''} disabled={busy} onChange={(e) => set('notes', e.target.value)} /></label>
        {error && <div className="error-box">{error}</div>}
        <div className="modal-actions lead-form-actions">
          <button className="button primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </form>
    </section>
  </div>
}

function LeadDetails({ client, lead, busy, error, onClose, onEdit, onRestore, onHistory, onArchive, onQueue, onMessage }: {
  client: SupabaseClient; lead: Lead; busy: boolean; error: string | null
  onClose: () => void; onEdit: () => void; onRestore: () => void; onHistory: () => void
  onArchive: () => void; onQueue: () => void; onMessage: (id: string) => void
}) {
  const phone = telegramPhone(lead.phone)
  const [messageId] = useState(() => crypto.randomUUID())
  return <div className="modal-backdrop" onMouseDown={(e) => { if (!busy && e.target === e.currentTarget) onClose() }}><section className="modal details-modal" role="dialog" aria-modal="true" aria-labelledby="lead-details-title">
    <button className="modal-close" aria-label="Закрыть" disabled={busy} onClick={onClose}><X /></button>
    <h2 id="lead-details-title">{lead.company_name}</h2>
    <p className="muted">Добавлен {formatDate(lead.created_at)}{lead.archived_at && ` · В архиве с ${formatDate(lead.archived_at)}`}</p>
    <div className="detail-grid"><Detail label="Телефон" value={lead.phone} icon={<Phone />} /><Detail label="Ниша" value={lead.niche} />
      <Detail label="Сайт" value={lead.website} link /><Detail label="Статус сайта" value={websiteStatusLabels[lead.website_status]} />
      <Detail label={sourceLabel(lead)} value={lead.source_url ?? lead.yandex_maps_url} link /><Detail label="Статус лида" value={statusLabels[lead.status]} />
      <Detail label="Приоритет" value={priorityLabels[lead.priority]} /><Detail label="Адрес" value={[lead.city, lead.address].filter(Boolean).join(', ')} />
      <Detail label="Заметки" value={lead.notes} wide /></div>
    <div className="activity-actions">
      {phone ? <a className="button secondary" href={`https://t.me/${phone}`} target="_blank" rel="noopener noreferrer"><Send /> Проверить Telegram</a>
        : <button className="button secondary" disabled><Send /> Проверить Telegram</button>}
      <button className="button secondary" disabled={busy} onClick={onHistory}><Phone /> История звонков</button>
    </div>
    <p>{phone ? 'Профиль откроется, если это разрешено настройками Telegram.' : 'Для проверки Telegram нужен корректный российский номер.'}</p>
    {!lead.archived_at && <div className="activity-actions">
      {isMailingLead(lead) && <button className="button primary" disabled={busy} onClick={() => onMessage(messageId)}>Отметить сообщение</button>}
      <button className="button secondary" disabled={busy || lead.manually_queued_for_calls} onClick={onQueue}><Phone />
        {lead.manually_queued_for_calls ? 'Уже на прозвоне' : 'Прозвонить'}</button>
      <button className="button danger-button" disabled={busy} onClick={onArchive}>Убрать</button>
    </div>}
    <OutreachHistory client={client} leadId={lead.id} />
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>Закрыть</button>
      {lead.archived_at ? <button className="button primary" disabled={busy} onClick={onRestore}><ArchiveRestore /> {busy ? 'Восстанавливаем…' : 'Восстановить'}</button>
        : <button className="button secondary" disabled={busy} onClick={onEdit}><Pencil /> Редактировать</button>}</div>
  </section></div>
}

function ConfirmDialog({ title, text, label = 'Удалить', pendingLabel = 'Удаляем…', busy, error, onClose, onConfirm }: {
  title: string; text: string; label?: string; pendingLabel?: string; busy: boolean; error: string | null
  onClose: () => void; onConfirm: () => void
}) {
  return <div className="modal-backdrop"><section className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-lead-title" aria-describedby="confirm-lead-text">
    <h2 id="confirm-lead-title">{title}</h2><p id="confirm-lead-text">{text}</p>{error && <div className="error-box" role="alert">{error}</div>}
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>
      <button className="button danger-button" disabled={busy} onClick={onConfirm}>{busy ? pendingLabel : label}</button></div>
  </section></div>
}

function StatusBadge({ status }: { status: LeadStatus }) { return <span className={`badge status-${status}`}>{statusLabels[status]}</span> }
function PriorityBadge({ priority }: { priority: LeadPriority }) { return <span className={`badge priority-${priority}`}><i />{priorityLabels[priority]}</span> }
function FormField({ label, value, onChange, required, disabled, placeholder, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; disabled?: boolean; placeholder?: string; type?: string }) { return <label className="field"><span>{label}</span><input type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required} disabled={disabled} placeholder={placeholder} /></label> }
function SelectField({ label, value, options, onChange, disabled }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
    {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
}
function Detail({ label, value, icon, link, wide }: { label: string; value: string | null; icon?: React.ReactNode; link?: boolean; wide?: boolean }) { const safeLink = link && value && /^https?:\/\//i.test(value); return <div className={`detail ${wide ? 'wide' : ''}`}><span>{icon}{label}</span>{safeLink ? <a href={value} target="_blank" rel="noreferrer">{value}<ExternalLink /></a> : <strong>{value?.trim() || 'Не указано'}</strong>}</div> }
function emptyDraft(): LeadDraft { return { company_name: '', niche: '', priority: 'normal', status: 'newLead', website_status: 'unknown', phone: null, website: null, yandex_maps_url: null, notes: null, next_action_at: null } }
function toDraft(lead: Lead): LeadDraft { return { company_name: lead.company_name, niche: lead.niche, priority: lead.priority, status: lead.status, website_status: lead.website_status, phone: lead.phone, website: lead.website, yandex_maps_url: lead.yandex_maps_url, notes: lead.notes, next_action_at: lead.next_action_at } }
function sourceLabel(lead: Lead): string { return lead.import_source === '2gis' ? '2ГИС' : lead.import_source === 'yandex_maps' || lead.yandex_maps_url ? 'Яндекс Карты' : 'Карточка источника' }
function emptyToNull(value: string | null): string | null { return value?.trim() || null }
