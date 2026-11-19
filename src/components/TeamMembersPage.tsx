import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAnalytics } from '../hooks/useAnalytics'
import { money, number, timeLabel, type Employee, type EmployeeActivity } from '../lib/analytics'
import type { Lead } from '../types'
import { AnalyticsStatus, EmployeeDetails } from './EmployeePage'

type Sort = 'today' | 'total' | 'earnings' | 'last_activity'

export function TeamMembersPage({ client, workspaceId, leads, revision }: {
  client: SupabaseClient; workspaceId: string; leads: Lead[]; revision: number
}) {
  const directory = useAnalytics<Employee[]>(client, 'crm_team_members', { p_workspace_id: workspaceId }, revision)
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('today')
  const members = directory.data ?? []
  const filtered = members.filter((member) => member.login.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')))
    .sort((a, b) => sort === 'last_activity'
      ? (b.last_activity ?? '').localeCompare(a.last_activity ?? '')
      : (b[sort] - a[sort]) || a.login.localeCompare(b.login, 'ru'))
  return <div className="page analytics-page">
    <div className="page-heading"><div><h1>Пользователи</h1><p>Участники команды и их показатели</p></div></div>
    <AnalyticsStatus error={directory.error} loading={!directory.data} refresh={directory.refresh} />
    {directory.data && (selected ? <div className="analytics-stack">
      <div className="analytics-panel employee-switch">
        <button className="button secondary" onClick={() => setSelected('')}>К списку пользователей</button>
        <label className="field"><span>Сотрудник</span><select aria-label="Сотрудник" value={selected} onChange={(event) => setSelected(event.target.value)}>
          {members.map((member) => <option key={member.id} value={member.id}>{member.login}</option>)}
        </select></label>
      </div>
      <SelectedEmployee key={selected} client={client} workspaceId={workspaceId} userId={selected}
        revision={revision} leads={leads} onSaved={directory.refresh} />
    </div> : <section className="analytics-panel">
      <div className="analytics-directory-filter">
        <label className="field"><span>Поиск сотрудника</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="field"><span>Сортировка</span><select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          <option value="today">По рассылкам за сегодня</option><option value="total">По рассылкам за всё время</option>
          <option value="last_activity">По последней рассылке</option><option value="earnings">По заработку</option>
        </select></label>
      </div>
      {filtered.length ? <div className="analytics-table-scroll"><table className="analytics-table">
        <thead><tr><th>Пользователь</th><th>Сегодня</th><th>Рассылок всего</th><th>Заработано</th><th>Последняя рассылка</th></tr></thead>
        <tbody>{filtered.map((member) => <tr key={member.id}>
          <td><button className="analytics-name" onClick={() => setSelected(member.id)}>{member.login}</button></td>
          <td>{number.format(member.today)}</td><td>{number.format(member.total)}</td><td>{money(member.earnings)}</td>
          <td>{member.last_activity ? timeLabel(member.last_activity) : '—'}</td>
        </tr>)}</tbody>
      </table></div> : <p className="muted">Пользователи не найдены.</p>}
    </section>)}
  </div>
}

function SelectedEmployee({ client, workspaceId, userId, revision, leads, onSaved }: {
  client: SupabaseClient; workspaceId: string; userId: string; revision: number; leads: Lead[]; onSaved: () => void
}) {
  const report = useAnalytics<EmployeeActivity>(client, 'crm_employee_activity',
    { p_workspace_id: workspaceId, p_user_id: userId }, revision)
  return <>
    <AnalyticsStatus error={report.error} loading={!report.data} refresh={report.refresh} />
    {report.data && <EmployeeDetails client={client} workspaceId={workspaceId} userId={userId} revision={revision}
      admin editActivity leads={leads} activity={report.data} onSaved={() => { report.refresh(); onSaved() }} />}
  </>
}
