import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Building2, Mail, Phone, Send } from 'lucide-react'
import { getErrorMessage, withTimeout } from '../lib/errors'

const leadMetrics = [
  { key: 'total', label: 'Всего', icon: Building2 },
  { key: 'mailing', label: 'Рассылка', icon: Send },
  { key: 'calls_queue', label: 'Звонки', icon: Phone },
  { key: 'messaged', label: 'Лиды, которым написали', icon: Mail },
] as const
const activityMetrics = [
  { key: 'offers', label: 'Отправлено офферов', icon: Send },
  { key: 'calls_made', label: 'Звонки с результатом', icon: Phone },
] as const
type Metric = (typeof leadMetrics | typeof activityMetrics)[number]
type Statistics = Record<Metric['key'], number>
const manualMessagedCount = 39

export function StatisticsPage({ client, workspaceId, totalLeads }: {
  client: SupabaseClient; workspaceId: string; totalLeads: number | null
}) {
  const [data, setData] = useState<Statistics | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    let request = 0
    const refresh = async () => {
      const current = ++request
      try {
        const { data: result, error: failure } = await withTimeout(client.rpc('crm_sales_statistics', { p_workspace_id: workspaceId }))
        if (failure) throw failure
        if (active && current === request) { setData(result as Statistics); setError('') }
      } catch (failure) {
        if (active && current === request) setError(getErrorMessage(failure))
      }
    }
    void refresh()
    const channel = client.channel(`sales-statistics:${workspaceId}`)
    for (const table of ['leads', 'lead_calls', 'lead_outreach']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` }, () => void refresh())
    }
    channel.subscribe((state) => { if (state === 'SUBSCRIBED') void refresh() })
    const interval = window.setInterval(() => void refresh(), 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      void client.removeChannel(channel)
    }
  }, [client, workspaceId, retry])

  return <div className="page statistics-page">
    <div className="page-heading"><div><h1>Статистика</h1><p>Лиды и результаты продаж вашей команды</p></div></div>
    {error && <div className="error-box" role="alert">{error} <button className="button text" onClick={() => setRetry((value) => value + 1)}>Обновить</button></div>}
    <section aria-labelledby="lead-metrics"><h2 id="lead-metrics">Лиды</h2>
      <Metrics cards={leadMetrics} data={{ ...data, total: totalLeads ?? undefined, messaged: manualMessagedCount }} />
      <p className="storage-note">«Всего» включает архивные карточки. «Лиды, которым написали» — ручное значение.</p>
    </section>
    <section aria-labelledby="activity-metrics"><h2 id="activity-metrics">Действия</h2>
      <Metrics cards={activityMetrics} data={data} />
      <p className="storage-note">Офферы учитываются по отметкам об отправке. В звонки входят попытки дозвона с указанным результатом.</p>
    </section>
  </div>
}

function Metrics({ cards, data }: { cards: readonly Metric[]; data: Partial<Statistics> | null }) {
  return <div className="stats-grid">
    {cards.map(({ key, label, icon: Icon }) => <article className="stat-card" key={key}>
      <div className="stat-icon"><Icon /></div><div><span>{label}</span><strong>{data?.[key]?.toLocaleString('ru-RU') ?? '—'}</strong></div>
    </article>)}
  </div>
}
