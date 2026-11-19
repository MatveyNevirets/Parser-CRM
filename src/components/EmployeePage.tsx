import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Pencil, Plus, UserRound } from 'lucide-react'
import { ActivityCalendar, ActivityChart, PeriodTotals, ReportedTeamTotal } from './ActivityCharts'
import { ActivityCorrections } from './ActivityCorrections'
import { useAnalytics } from '../hooks/useAnalytics'
import { calendarDate, fullDate, money, timeLabel, type Earning, type EmployeeActivity } from '../lib/analytics'
import { getErrorMessage, withTimeout } from '../lib/errors'
import type { Lead } from '../types'

interface EmployeeProps {
  client: SupabaseClient; workspaceId: string; userId: string; revision: number; admin: boolean; leads: Lead[]
}

export function EmployeePage(props: EmployeeProps) {
  const report = useAnalytics<EmployeeActivity>(props.client, 'crm_employee_activity',
    { p_workspace_id: props.workspaceId, p_user_id: props.userId }, props.revision)
  return <div className="page analytics-page">
    <div className="page-heading"><div><h1>Личный кабинет</h1></div></div>
    <AnalyticsStatus error={report.error} loading={!report.data} refresh={report.refresh} />
    <div className="analytics-stack">
      <ReportedTeamTotal />
      {report.data && <EmployeeDetails {...props} activity={report.data} onSaved={report.refresh} />}
    </div>
  </div>
}

export function EmployeeDetails({ activity, onSaved, editActivity = false, ...props }: EmployeeProps & {
  activity: EmployeeActivity; onSaved: () => void; editActivity?: boolean
}) {
  return <div className="analytics-stack">
    <section className="analytics-panel employee-profile">
      <div className="employee-icon"><UserRound /></div>
      <div><h2>{activity.profile.login}</h2><p>{activity.profile.is_admin ? 'Администратор' : 'Сотрудник'}
        {activity.profile.created_at && ` · Аккаунт создан ${timeLabel(activity.profile.created_at, activity.zone)}`}</p></div>
    </section>
    <section className="analytics-panel"><h3>Статистика рассылок</h3>
      <PeriodTotals totals={activity.counts} totalLabel="Лично за всё время" /></section>
    {props.admin && editActivity && <ActivityCorrections {...props} today={activity.today} onSaved={onSaved} />}
    <ActivityChart activity={activity} />
    <ActivityCalendar activity={activity} />
    {activity.earnings && <>
      <section className="analytics-panel">
        <h3>Заработано за всё время</h3><strong className="analytics-money">{money(activity.earnings.total)}</strong>
        <PeriodTotals totals={activity.earnings} format={money} />
      </section>
      <ActivityChart activity={activity} financial />
      <EarningsHistory {...props} today={activity.today} onSaved={onSaved} />
    </>}
  </div>
}

export function AnalyticsStatus({ error, loading, refresh }: { error: string; loading: boolean; refresh: () => void }) {
  if (error) return <div className="error-box" role="alert">{error} <button className="button text" onClick={refresh}>Обновить</button></div>
  return loading ? <div className="table-state" role="status"><div className="spinner" />Загружаем данные…</div> : null
}

function EarningsHistory({ client, workspaceId, userId, revision, admin, leads, today, onSaved }: EmployeeProps & {
  today: string; onSaved: () => void
}) {
  const [page, setPage] = useState(0)
  const [edit, setEdit] = useState<Earning | 'new' | null>(null)
  const [notice, setNotice] = useState('')
  const history = useAnalytics<Earning[]>(client, 'crm_earnings_history',
    { p_workspace_id: workspaceId, p_user_id: userId, p_offset: page * 25 }, revision)
  return <section className="analytics-panel">
    <header className="analytics-heading"><h3>История начислений</h3>
      {admin && <button className="button secondary" onClick={() => { setNotice(''); setEdit('new') }}><Plus /> Добавить начисление</button>}</header>
    {notice && <p className="success-note" role="status">{notice}</p>}
    {edit && <EarningForm key={edit === 'new' ? 'new' : edit.id} client={client} workspaceId={workspaceId} userId={userId}
      previous={edit === 'new' ? null : edit} leads={leads} today={today} onClose={() => setEdit(null)} onSaved={() => {
        setEdit(null); setNotice('Начисление сохранено.'); history.refresh(); onSaved()
      }} />}
    <AnalyticsStatus error={history.error} loading={!history.data} refresh={history.refresh} />
    {history.data && (history.data.length ? <div className="analytics-table-scroll"><table className="analytics-table">
      <thead><tr><th>Дата</th><th>Сумма</th><th>Карточка</th><th>Комментарий</th>{admin && <th>Действия</th>}</tr></thead>
      <tbody>{history.data.slice(0, 25).map((entry) => <tr key={entry.id}>
        <td>{fullDate(calendarDate(entry.earned_on))}</td><td>{money(entry.amount_kopecks)}</td>
        <td>{entry.company_name ?? '—'}</td><td>{entry.comment || '—'}</td>
        {admin && <td><button className="icon-button" disabled={Boolean(edit)} aria-label="Редактировать начисление"
          onClick={() => { setNotice(''); setEdit(entry) }}><Pencil /></button></td>}
      </tr>)}</tbody>
    </table></div> : <p className="muted">Начислений пока нет.</p>)}
    {(page > 0 || (history.data?.length ?? 0) > 25) && <div className="activity-actions">
      <button className="button secondary" disabled={page === 0 || Boolean(edit)} onClick={() => setPage(page - 1)}>Назад</button>
      <button className="button secondary" disabled={(history.data?.length ?? 0) <= 25 || Boolean(edit)}
        onClick={() => setPage(page + 1)}>Далее</button>
    </div>}
  </section>
}

function EarningForm({ previous, client, workspaceId, userId, leads, today, onClose, onSaved }: {
  previous: Earning | null; client: SupabaseClient; workspaceId: string; userId: string; leads: Lead[]
  today: string; onClose: () => void; onSaved: () => void
}) {
  const [id] = useState(() => previous?.id ?? crypto.randomUUID())
  const [amount, setAmount] = useState(previous ? String(previous.amount_kopecks / 100) : '')
  const [date, setDate] = useState(previous?.earned_on ?? today)
  const [comment, setComment] = useState(previous?.comment ?? '')
  const [lead, setLead] = useState(previous?.lead_id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const linkedLead = previous?.lead_id && !leads.some((item) => item.id === previous.lead_id) ? previous : null
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(amount.trim())
    const kopecks = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : -1
    if (kopecks < (previous ? 0 : 1) || kopecks > 10_000_000_000) {
      setError(previous ? 'Введите сумму от 0 до 100 млн ₽ с точностью до копейки.'
        : 'Введите положительную сумму до 100 млн ₽ с точностью до копейки.'); return
    }
    setBusy(true); setError('')
    try {
      const { error: failure } = await withTimeout(client.rpc('crm_save_earning', {
        p_workspace_id: workspaceId, p_user_id: userId, p_id: id, p_version: previous?.version ?? null,
        p_amount_kopecks: kopecks, p_earned_on: date, p_comment: comment.trim(), p_lead_id: lead || null,
      }))
      if (failure) throw failure
      onSaved()
    } catch (failure) { setError(getErrorMessage(failure)) }
    finally { setBusy(false) }
  }
  return <form className="analytics-form" onSubmit={(event) => void save(event)}>
    <div className="form-grid">
      <label className="field"><span>Сумма в рублях</span><input value={amount} onChange={(event) => setAmount(event.target.value)}
        inputMode="decimal" required disabled={busy} /></label>
      <label className="field"><span>Дата начисления</span><input type="date" required max={today} value={date}
        onChange={(event) => setDate(event.target.value)} disabled={busy} /></label>
    </div>
    <label className="field"><span>Связанный лид</span><select value={lead} onChange={(event) => setLead(event.target.value)} disabled={busy}>
      <option value="">Без привязки</option>{linkedLead && <option value={linkedLead.lead_id ?? ''}>{linkedLead.company_name ?? 'Сохранённая карточка'}</option>}
      {leads.map((item) => <option key={item.id} value={item.id}>{item.company_name}</option>)}
    </select></label>
    <label className="field"><span>Комментарий или источник</span><textarea rows={2} value={comment} maxLength={1000}
      onChange={(event) => setComment(event.target.value)} disabled={busy} /></label>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="activity-actions"><button className="button primary" disabled={busy}>Сохранить начисление</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button></div>
  </form>
}
