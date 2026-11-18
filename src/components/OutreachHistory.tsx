import type { SupabaseClient } from '@supabase/supabase-js'
import { useLeadHistory } from '../hooks/useLeadHistory'
import { formatDate, outreachLabels, type OutreachEvent } from '../lib/sales'

export function OutreachHistory({ client, leadId }: {
  client: SupabaseClient; leadId: string
}) {
  const history = useLeadHistory<OutreachEvent>(client, 'lead_outreach', leadId)

  return <section className="activity-section">
    <h3>История рассылки</h3>
    {history.error ? <div className="error-box" role="alert">{history.error} <button className="button text" onClick={history.refresh}>Обновить историю</button></div>
      : !history.rows ? <p>Загружаем историю…</p>
        : !history.rows.length ? <p>Отправки пока не отмечены.</p>
          : <ul className="outreach-list">{history.rows.map((event) => <li key={event.id}>
            <span>{outreachLabels[event.kind]}</span><time dateTime={event.occurred_at}>{formatDate(event.occurred_at)}</time>
          </li>)}</ul>}
    {history.more && <button className="button text" disabled={history.loadingMore} onClick={history.loadMore}>Показать ещё</button>}
  </section>
}
