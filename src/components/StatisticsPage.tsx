import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Building2, Phone, Send } from 'lucide-react'
import { useAnalytics } from '../hooks/useAnalytics'
import { TeamActivityPanel } from './TeamActivityPanel'

const leadMetrics = [
  { key: 'total', label: 'Всего', icon: Building2 },
  { key: 'mailing', label: 'Рассылка', icon: Send },
  { key: 'calls_queue', label: 'Звонки', icon: Phone },
] as const
const activityMetrics = [
  { key: 'offers', label: 'Отправлено офферов', icon: Send },
  { key: 'calls_made', label: 'Звонки с результатом', icon: Phone },
] as const
type Metric = (typeof leadMetrics | typeof activityMetrics)[number]
type Statistics = Record<Metric['key'], number>

export function StatisticsPage({ client, workspaceId, totalLeads, revision, admin }: {
  client: SupabaseClient; workspaceId: string; totalLeads: number | null; revision: number; admin: boolean
}) {
  const [salesRevision, setSalesRevision] = useState(0)
  const { data, error, refresh } = useAnalytics<Statistics>(client, 'crm_sales_statistics',
    { p_workspace_id: workspaceId }, revision + salesRevision)

  useEffect(() => {
    const changed = () => setSalesRevision((value) => value + 1)
    const channel = client.channel(`sales-statistics:${workspaceId}`)
    for (const table of ['leads', 'lead_calls']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` }, changed)
    }
    channel.subscribe((state) => { if (state === 'SUBSCRIBED') changed() })
    return () => {
      void client.removeChannel(channel)
    }
  }, [client, workspaceId])

  return <div className="page statistics-page">
    <div className="page-heading"><div><h1>Статистика</h1><p>Лиды и результаты продаж вашей команды</p></div></div>
    {error && <div className="error-box" role="alert">{error} <button className="button text" onClick={refresh}>Обновить</button></div>}
    <section aria-labelledby="lead-metrics"><h2 id="lead-metrics">Лиды</h2>
      <Metrics cards={leadMetrics} data={{ ...data, total: totalLeads ?? undefined }} />
      <p className="storage-note">«Всего» включает архивные карточки.</p>
    </section>
    <TeamActivityPanel client={client} workspaceId={workspaceId} revision={revision} admin={admin} />
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
