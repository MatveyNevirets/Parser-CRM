import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Archive, BarChart3, BriefcaseBusiness, Building2, CircleGauge, Cloud, Copy, Leaf, LogOut, Map, Menu, UserRound, UsersRound, X } from 'lucide-react'
import type { Workspace } from '../types'
import { useLeads } from '../hooks/useLeads'
import { LeadsPage } from './LeadsPage'
import { ParserPage } from './ParserPage'
import { StatisticsPage } from './StatisticsPage'
import { EmployeePage } from './EmployeePage'
import { TeamMembersPage } from './TeamMembersPage'
import { useActivityRevision } from '../hooks/useAnalytics'

type Section = 'overview' | 'leads' | 'parser' | 'statistics' | 'archive' | 'employee' | 'members'

export function Dashboard({ client, workspace, email, userId, onSignOut }: {
  client: SupabaseClient; workspace: Workspace; email: string; userId: string; onSignOut: () => void
}) {
  const [section, setSection] = useState<Section>('leads')
  const [teamOpen, setTeamOpen] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const leadsState = useLeads(client, workspace.id)
  const revision = useActivityRevision(client, workspace.id)
  const admin = workspace.owner_id === userId
  const choose = (next: Section) => { setSection(next); setMobileNav(false) }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <div className="side-brand"><div className="brand-mark"><Leaf /></div><div><strong>Pahota</strong><span>CRM</span></div></div>
      <button className="mobile-close" aria-label="Закрыть меню" onClick={() => setMobileNav(false)}><X /></button>
      <p className="side-label">РАБОЧЕЕ ПРОСТРАНСТВО</p>
      <nav>
        <button className={section === 'overview' ? 'active' : ''} onClick={() => choose('overview')}><CircleGauge /> <span>Обзор</span></button>
        <button className={section === 'leads' ? 'active' : ''} onClick={() => choose('leads')}><Building2 /> <span>Лиды</span></button>
        <button className={section === 'parser' ? 'active' : ''} onClick={() => choose('parser')}>
          <Map /> <span>Парсер</span>
        </button>
        <button className={section === 'statistics' ? 'active' : ''} onClick={() => choose('statistics')}><BarChart3 /> <span>Статистика</span></button>
        <button className={section === 'archive' ? 'active' : ''} onClick={() => choose('archive')}><Archive /> <span>Архив</span></button>
        <button className={section === 'employee' ? 'active' : ''} onClick={() => choose('employee')}><UserRound /> <span>Личный кабинет</span></button>
        {admin && <button className={section === 'members' ? 'active' : ''} onClick={() => choose('members')}><UsersRound /> <span>Пользователи</span></button>}
      </nav>
      <div className="sidebar-status"><Cloud /><div><strong>Общая база</strong><span>{leadsState.realtimeConnected ? 'Синхронизация включена' : 'Подключение…'}</span></div></div>
    </aside>
    {mobileNav && <button className="nav-backdrop" aria-label="Закрыть меню" onClick={() => setMobileNav(false)} />}
    <div className="main-column">
      <header className="topbar">
        <button className="menu-button" aria-label="Открыть меню" onClick={() => setMobileNav(true)}><Menu /></button>
        <div className={`sync-dot ${leadsState.realtimeConnected ? 'online' : ''}`} />
        <strong className="team-title">{workspace.name}</strong>
        <div className="top-actions">
          <button className="icon-button" title="Команда и код приглашения" onClick={() => setTeamOpen(true)}><UsersRound /></button>
          <button className="icon-button" title="Выйти" onClick={onSignOut}><LogOut /></button>
          <div className="avatar">{email.slice(0, 1).toUpperCase()}</div>
        </div>
      </header>
      <main className="workspace">
        {section === 'leads' && <LeadsPage client={client} {...leadsState} />}
        {section === 'archive' && <LeadsPage client={client} {...leadsState} archive />}
        {section === 'parser' && <ParserPage client={client} workspaceId={workspace.id} userId={userId} />}
        {section === 'statistics' && <StatisticsPage client={client} workspaceId={workspace.id} revision={revision} admin={admin}
          totalLeads={leadsState.loading || leadsState.error ? null : leadsState.leads.length} />}
        {section === 'employee' && <EmployeePage client={client} workspaceId={workspace.id} userId={userId}
          revision={revision} admin={admin} leads={leadsState.leads} />}
        {section === 'members' && admin && <TeamMembersPage client={client} workspaceId={workspace.id}
          revision={revision} leads={leadsState.leads} />}
        {section === 'overview' && <Overview leads={leadsState.leads.filter((lead) => !lead.archived_at)}
          loading={leadsState.loading} onOpenLeads={() => setSection('leads')} />}
      </main>
    </div>
    {teamOpen && <TeamDialog workspace={workspace} email={email} onClose={() => setTeamOpen(false)} />}
  </div>
}

function Overview({ leads, loading, onOpenLeads }: {
  leads: ReturnType<typeof useLeads>['leads']; loading: boolean; onOpenLeads: () => void
}) {
  const active = leads.filter((lead) => lead.status === 'inProgress' || lead.status === 'offer').length
  const high = leads.filter((lead) => lead.priority === 'high').length
  return <div className="page overview-page">
    <div className="page-heading"><div><h1>Обзор</h1><p>Рабочее пространство вашей команды</p></div></div>
    <section className="hero-card"><div><span className="eyebrow">PAHOTA CRM</span><h2>Всё для спокойной работы с лидами</h2><p>Собирайте контакты, фиксируйте общение и планируйте следующие шаги вместе.</p></div><BarChart3 /></section>
    <div className="stats-grid">
      <Stat icon={<Building2 />} label="Всего лидов" value={leads.length} loading={loading} />
      <Stat icon={<BriefcaseBusiness />} label="В работе" value={active} loading={loading} />
      <Stat icon={<CircleGauge />} label="Высокий приоритет" value={high} loading={loading} />
    </div>
    <section className="overview-panel"><div><h3>Актуальная база всегда рядом</h3><p>Новые и изменённые карточки появляются у участников команды автоматически.</p></div><button className="button primary" onClick={onOpenLeads}>Открыть лиды</button></section>
  </div>
}

function Stat({ icon, label, value, loading }: { icon: React.ReactNode; label: string; value: number; loading: boolean }) {
  return <article className="stat-card"><div className="stat-icon">{icon}</div><div><span>{label}</span><strong>{loading ? '—' : value}</strong></div></article>
}

function TeamDialog({ workspace, email, onClose }: { workspace: Workspace; email: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => { await navigator.clipboard.writeText(workspace.invite_code); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="team-title">
      <button className="modal-close" aria-label="Закрыть" onClick={onClose}><X /></button>
      <div className="modal-icon"><UsersRound /></div><h2 id="team-title">{workspace.name}</h2><p className="muted">{email}</p>
      <p>Передайте другу URL, публичный ключ проекта и этот код. Он входит со своим аккаунтом CRM и выбирает «Присоединиться».</p>
      <div className="invite-code"><code>{workspace.invite_code}</code><button className="icon-button" title="Копировать" onClick={() => void copy()}><Copy /></button></div>
      <p className="form-note">Код даёт доступ к данным команды — не публикуйте его.</p>
      <button className="button primary" onClick={() => void copy()}>{copied ? 'Скопировано' : 'Копировать код'}</button>
    </section>
  </div>
}
