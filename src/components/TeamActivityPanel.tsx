import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAnalytics } from '../hooks/useAnalytics'
import { money, number, timeLabel, type TeamActivity } from '../lib/analytics'
import { getErrorMessage, withTimeout } from '../lib/errors'
import { ActivityChart, PeriodTotals, ReportedTeamTotal } from './ActivityCharts'
import { AnalyticsStatus } from './EmployeePage'
import { MailingLeaderboard } from './MailingLeaderboard'

export function TeamActivityPanel({ client, workspaceId, revision, admin }: {
  client: SupabaseClient; workspaceId: string; revision: number; admin: boolean
}) {
  const report = useAnalytics<TeamActivity>(client, 'crm_team_activity', { p_workspace_id: workspaceId }, revision)
  const activity = report.data
  const additional = activity?.reconciliation?.additional ?? 0
  return <section aria-labelledby="team-activity">
    <h2 id="team-activity">Активность команды</h2>
    <div className="analytics-stack team-activity-stack">
      <ReportedTeamTotal />
      <AnalyticsStatus error={report.error} loading={!activity} refresh={report.refresh} />
      {activity && <>
      <section className="analytics-panel" aria-label="Рассылки команды">
        <PeriodTotals totals={{ ...activity.counts, total: activity.counts.total + additional }} totalLabel="Учтено за всё время" />
        {activity.reconciliation && additional > 0 && <p className="analytics-meta">
          За всё время учтено {number.format(activity.counts.total)} рассылок по событиям и корректировкам, плюс {number.format(additional)} исторических отправок без дат и авторов.
        </p>}
      </section>
      {admin && <MailingLeaderboard client={client} workspaceId={workspaceId} today={activity.today} revision={revision} />}
      <ActivityChart activity={activity} />
      {activity.earnings && <>
        <section className="analytics-panel">
          <h3>Заработано командой</h3><strong className="analytics-money">{money(activity.earnings.total)}</strong>
          <PeriodTotals totals={activity.earnings} format={money} />
        </section>
        <ActivityChart activity={activity} financial />
      </>}
      {admin && (activity.reconciliation ? <p className="analytics-meta">Историческая сверка сохранена по состоянию на {timeLabel(activity.reconciliation.cutoff, activity.zone)}.</p>
        : <Reconciliation client={client} workspaceId={workspaceId} onSaved={report.refresh} />)}
      </>}
    </div>
  </section>
}

function Reconciliation({ client, workspaceId, onSaved }: { client: SupabaseClient; workspaceId: string; onSaved: () => void }) {
  const [cutoff, setCutoff] = useState('')
  const [preview, setPreview] = useState<{ recorded: number; additional: number } | null>(null)
  const [evidence, setEvidence] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const check = async (expected: number | null) => {
    setBusy(true); setError('')
    try {
      const { data, error: failure } = await withTimeout(client.rpc('crm_reconcile_mailing', {
        p_workspace_id: workspaceId, p_cutoff: cutoff, p_expected_recorded: expected, p_evidence: evidence.trim(),
      }))
      if (failure) throw failure
      if (expected === null) setPreview(data as typeof preview)
      else onSaved()
    } catch (failure) {
      setPreview(null); setError(getErrorMessage(failure))
    } finally { setBusy(false) }
  }
  return <details className="analytics-panel">
    <summary>Историческая сверка рассылок</summary>
    <p className="analytics-meta">Укажите момент, к которому относятся подтверждённые 55 отправок. Время по Волгограду.</p>
    <form className="analytics-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void check(null) }}>
      <label className="field"><span>Дата и время сверки</span><input type="datetime-local" required step="1" value={cutoff} disabled={busy}
        onChange={(event) => { setCutoff(event.target.value); setPreview(null); setError('') }} /></label>
      <div className="activity-actions"><button className="button secondary" disabled={busy}>Проверить события</button></div>
    </form>
    {preview && <div className="analytics-form">
      <p>В базе за этот период {preview.recorded} подтверждённых отправок.</p>
      {preview.recorded <= 55 ? <>
        <p>Будет учтено {preview.additional} исторических отправок без распределения по сотрудникам и датам.</p>
        {preview.recorded < 39 && <label className="field"><span>Источник подтверждённого итога 55</span>
          <textarea rows={2} maxLength={1000} value={evidence} disabled={busy} onChange={(event) => setEvidence(event.target.value)} />
        </label>}
        <button className="button primary" disabled={busy || (preview.recorded < 39 && evidence.trim().length < 5)}
          onClick={() => void check(preview.recorded)}>
          Подтвердить сверку до 55
        </button>
      </> : <p className="analytics-meta">В базе уже больше 55 отправок. Проверьте дату и время сверки.</p>}
    </div>}
    {error && <div className="error-box" role="alert">{error}</div>}
  </details>
}
