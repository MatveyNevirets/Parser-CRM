import { useEffect, useMemo, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { clearSettings, makeClient, readSettings, saveSettings, type ConnectionSettings } from './lib/supabase'
import { getErrorMessage, withTimeout } from './lib/errors'
import type { Workspace } from './types'
import { ConnectionScreen, LoginScreen, WorkspaceScreen } from './components/AuthScreens'
import { Dashboard } from './components/Dashboard'

export function App() {
  const [settings, setSettings] = useState<ConnectionSettings | null>(() => readSettings())
  const client = useMemo(() => settings ? makeClient(settings) : null, [settings])
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const userId = session?.user.id
  const [workspaceState, setWorkspaceState] = useState<{
    client: SupabaseClient; userId: string; value: Workspace | null
  } | null>(null)
  // Never show a previous account's workspace while the next account loads.
  const workspace = workspaceState?.client === client && workspaceState.userId === userId
    ? workspaceState.value : undefined
  const [workspaceVersion, setWorkspaceVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client) { setSession(undefined); return }
    let active = true
    void client.auth.getSession().then(({ data, error: authError }) => {
      if (!active) return
      if (authError) setError(getErrorMessage(authError))
      setSession(data.session)
    })
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
    })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [client])

  useEffect(() => {
    if (!client || !userId) { setWorkspaceState(null); return }
    let active = true
    setWorkspaceState(null)
    setError(null)
    // SIGNED_IN can repeat on tab return; TOKEN_REFRESHED also replaces Session.
    // Neither changes the workspace identity or should unmount the working UI.
    void loadWorkspace(client, userId).then((value) => {
      if (active) setWorkspaceState({ client, userId, value })
    }).catch((caught) => {
      if (active) { setError(getErrorMessage(caught)); setWorkspaceState({ client, userId, value: null }) }
    })
    return () => { active = false }
  }, [client, userId, workspaceVersion])

  if (!settings || !client) {
    return <ConnectionScreen onConnect={(next) => { saveSettings(next); setSettings(next) }} />
  }
  if (session === undefined) return <LoadingScreen text="Восстанавливаем сессию…" />
  if (!session) {
    return <LoginScreen client={client} initialError={error} onReset={() => {
      void client.auth.signOut({ scope: 'local' }).finally(() => {
        clearSettings(); setSettings(null); setError(null)
      })
    }} />
  }
  if (workspace === undefined) return <LoadingScreen text="Загружаем команду…" />
  if (!workspace) {
    return <WorkspaceScreen client={client} email={session.user.email ?? ''} initialError={error}
      onReady={() => setWorkspaceVersion((value) => value + 1)}
      onSignOut={() => void client.auth.signOut({ scope: 'local' })} />
  }
  return <Dashboard key={`${session.user.id}:${workspace.id}`} client={client} workspace={workspace} email={session.user.email ?? ''} userId={session.user.id}
    onSignOut={() => void client.auth.signOut({ scope: 'local' })} />
}

async function loadWorkspace(client: SupabaseClient, userId: string): Promise<Workspace | null> {
  const { data: membership, error: memberError } = await withTimeout(client.from('workspace_members')
    .select('workspace_id').eq('user_id', userId).maybeSingle())
  if (memberError) throw memberError
  if (!membership) return null
  const { data, error } = await withTimeout(client.from('workspaces').select('*')
    .eq('id', membership.workspace_id).single())
  if (error) throw error
  return data as Workspace
}

function LoadingScreen({ text }: { text: string }) {
  return <main className="center-page"><div className="loading-card">
    <div className="brand-mark">P</div><p>{text}</p><div className="progress"><span /></div>
  </div></main>
}
