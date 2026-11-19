import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAnalytics } from '../hooks/useAnalytics'
import { number } from '../lib/analytics'
import { getErrorMessage, withTimeout } from '../lib/errors'

interface Correction { id: string; hour_start: string; delta: number }
const correctionDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'Europe/Volgograd' })

export function ActivityCorrections({ client, workspaceId, userId, revision, today, onSaved }: {
  client: SupabaseClient; workspaceId: string; userId: string; revision: number; today: string; onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  return <section className="analytics-panel">
    <header className="analytics-heading"><h3>Корректировки рассылок</h3>
      <button className="button secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Закрыть' : 'Изменить статистику'}
      </button>
    </header>
    {open && <CorrectionEditor client={client} workspaceId={workspaceId} userId={userId}
      revision={revision} today={today} onSaved={onSaved} />}
  </section>
}

function CorrectionEditor({ client, workspaceId, userId, revision, today, onSaved }: {
  client: SupabaseClient; workspaceId: string; userId: string; revision: number; today: string; onSaved: () => void
}) {
  const params = { p_workspace_id: workspaceId, p_user_id: userId }
  const history = useAnalytics<Correction[]>(client, 'crm_activity_correction_history', params, revision)
  const [id, setId] = useState(() => crypto.randomUUID())
  const [date, setDate] = useState(today)
  const [operation, setOperation] = useState<'add' | 'subtract'>('add')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const quantity = Number(amount)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      setError('Введите целое число от 1 до 10 000.'); return
    }
    const delta = operation === 'add' ? quantity : -quantity
    setBusy(true); setError(''); setNotice('')
    try {
      const { error: failure } = await withTimeout(client.rpc('crm_add_daily_activity_correction', {
        ...params, p_id: id, p_date: date, p_delta: delta,
      }))
      if (failure) throw failure
      setId(crypto.randomUUID()); setAmount(''); setNotice('Корректировка сохранена.')
      history.refresh(); onSaved()
    } catch (failure) { setError(getErrorMessage(failure)) }
    finally { setBusy(false) }
  }

  return <>
    <form className="analytics-form" onSubmit={(event) => void save(event)}>
      <label className="field"><span>Дата рассылок</span><input type="date" value={date} max={today}
        required disabled={busy} onChange={(event) => setDate(event.target.value)} /></label>
      <div className="form-grid">
        <label className="field"><span>Действие</span><select aria-label="Действие" value={operation}
          disabled={busy} onChange={(event) => setOperation(event.target.value === 'subtract' ? 'subtract' : 'add')}>
          <option value="add">Прибавить</option><option value="subtract">Отнять</option>
        </select></label>
        <label className="field"><span>Количество рассылок</span><input type="number" required value={amount}
          min={1} max={10_000} disabled={busy} onChange={(event) => setAmount(event.target.value)} /></label>
      </div>
      {error && <div role="alert" className="error-box">{error}</div>}
      {notice && <p role="status" className="success-note">{notice}</p>}
      <button className="button primary" disabled={busy}>Сохранить корректировку</button>
    </form>
    {history.error && <div className="error-box" role="alert">{history.error}
      <button className="button text" onClick={history.refresh}>Обновить</button></div>}
    {history.data?.length ? <div className="analytics-table-scroll"><table className="analytics-table">
      <caption>Последние корректировки</caption>
      <thead><tr><th>Дата рассылок</th><th>Изменение</th></tr></thead>
      <tbody>{history.data.map((item) => <tr key={item.id}>
        <td>{correctionDate.format(new Date(item.hour_start))}</td><td>{item.delta > 0 ? '+' : ''}{number.format(item.delta)}</td>
      </tr>)}</tbody>
    </table></div> : !history.error && history.data && <p className="analytics-meta">Корректировок пока нет.</p>}
  </>
}
