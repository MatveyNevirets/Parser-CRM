import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAnalytics } from '../hooks/useAnalytics'
import { addDays, calendarDate, dateLabel, dayKey, fullDate, number } from '../lib/analytics'
import { AnalyticsStatus } from './EmployeePage'

const leaderboardPeriods = [
  { key: 'day', label: 'День' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
] as const
type LeaderboardPeriod = (typeof leaderboardPeriods)[number]['key']
interface Leaderboard {
  start: string; end: string
  members: { id: string; login: string; total: number; daily: Record<string, number>; position: number }[]
}

export function MailingLeaderboard({ client, workspaceId, today, revision }: {
  client: SupabaseClient; workspaceId: string; today: string; revision: number
}) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week')
  const [selectedDate, setSelectedDate] = useState('')
  const date = selectedDate || today
  const report = useAnalytics<Leaderboard>(client, 'crm_mailing_leaderboard', {
    p_workspace_id: workspaceId, p_on: date, p_period: period,
  }, revision)
  const data = report.data
  const days = period === 'week' && data
    ? Array.from({ length: 7 }, (_, index) => addDays(calendarDate(data.start), index)) : []
  const rangeLabel = data && (data.start === data.end
    ? fullDate(calendarDate(data.start)) : `${fullDate(calendarDate(data.start))} — ${fullDate(calendarDate(data.end))}`)

  return <section className="analytics-panel" aria-labelledby="mailing-leaderboard">
    <header className="analytics-heading">
      <h3 id="mailing-leaderboard">Лидерборд рассылок</h3>
      <div className="analytics-tabs" role="group" aria-label="Период лидерборда">
        {leaderboardPeriods.map(({ key, label }) => <button key={key} aria-pressed={period === key}
          onClick={() => setPeriod(key)}>{label}</button>)}
      </div>
    </header>
    <div className="analytics-leaderboard-controls">
      <label className="field"><span>Дата лидерборда</span><input type="date" max={today} value={date}
        onChange={(event) => setSelectedDate(event.target.value)} /></label>
      {selectedDate && selectedDate !== today && <button className="button text" onClick={() => setSelectedDate('')}>Сегодня</button>}
      {rangeLabel && <span className="analytics-meta" aria-live="polite">{rangeLabel}</span>}
    </div>
    <AnalyticsStatus error={report.error} loading={!data} refresh={report.refresh} />
    {data && (data.members.length ? <div className="analytics-table-scroll"><table className="analytics-table leaderboard-table">
      <thead><tr>
        <th scope="col">Место</th><th scope="col">Сотрудник</th>
        {days.map((day) => <th scope="col" key={dayKey(day)} className="leaderboard-day">
          {dateLabel(day, { weekday: 'short', day: 'numeric', month: 'numeric' })}
        </th>)}
        <th scope="col" className="leaderboard-day">{days.length ? 'Итого' : 'Рассылок'}</th>
      </tr></thead>
      <tbody>{data.members.map((member) => <tr key={member.id}>
        <td>{number.format(member.position)}</td><th scope="row">{member.login}</th>
        {days.map((day) => {
          const key = dayKey(day)
          return <td className="leaderboard-day" key={key}>{key > today ? '—' : number.format(member.daily[key] ?? 0)}</td>
        })}
        <td className="leaderboard-day"><strong>{number.format(member.total)}</strong></td>
      </tr>)}</tbody>
    </table></div> : <p className="analytics-meta">В команде пока нет сотрудников.</p>)}
    <p className="analytics-meta leaderboard-note">В рейтинге учитываются отметки отправки и персональные корректировки.</p>
  </section>
}
