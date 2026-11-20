import { useEffect, useMemo, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { makeClient, readSettings } from './lib/supabase'
import { withTimeout } from './lib/errors'
import type { Workspace } from './types'
import { LoginScreen, WorkspaceErrorScreen, WorkspaceScreen } from './components/AuthScreens'
import { Dashboard } from './components/Dashboard'

export function App() {
  const [settings] = useState(readSettings)
  const client = useMemo(() => makeClient(settings), [settings])
  const [authState, setAuthState] = useState<{
    session: Session | null; error?: string
  } | null>(null)
  const session = authState?.session
  const userId = session?.user.id
  const [workspaceVersion, setWorkspaceVersion] = useState(0)
  const [workspaceState, setWorkspaceState] = useState<{
    userId: string; version: number
  } & ({ value: Workspace | null } | { failed: true }) | null>(null)
  // Never show a previous account's workspace while the next account loads.
  const currentWorkspace = workspaceState && workspaceState.userId === userId
    && workspaceState.version === workspaceVersion ? workspaceState : null

  useEffect(() => {
    let active = true
    let sessionChanged = false
    const { data: listener } = client.auth.onAuthStateChange((event, nextSession) => {
      if (!active || (event === 'INITIAL_SESSION' && (!nextSession || sessionChanged))) return
      sessionChanged = true
      setAuthState({ session: nextSession })
    })
    void withTimeout(client.auth.getSession(), 8000).then(({ data, error }) => {
      if (error) throw error
      if (active && !sessionChanged) setAuthState({ session: data.session })
    }).catch(() => {
      if (active && !sessionChanged) setAuthState({ session: null, error: 'Не удалось восстановить сессию. Войдите ещё раз.' })
    })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [client])

  useEffect(() => {
    if (!userId) { setWorkspaceState(null); return }
    let active = true
    const identity = { userId, version: workspaceVersion }
    // SIGNED_IN can repeat on tab return; TOKEN_REFRESHED also replaces Session.
    // Neither changes the workspace identity or should unmount the working UI.
    void loadWorkspace(client, userId).then((value) => {
      if (active) setWorkspaceState({ ...identity, value })
    }).catch(() => {
      if (active) setWorkspaceState({ ...identity, failed: true })
    })
    return () => { active = false }
  }, [client, userId, workspaceVersion])

  if (session === undefined) return <LoadingScreen text="Восстанавливаем сессию…" />
  if (!session) return <LoginScreen client={client} initialError={authState?.error} />
  const reloadWorkspace = () => setWorkspaceVersion((value) => value + 1)
  const signOut = () => void client.auth.signOut({ scope: 'local' })
  if (!currentWorkspace) return <LoadingScreen text="Загружаем команду…" />
  if ('failed' in currentWorkspace) {
    return <WorkspaceErrorScreen onRetry={reloadWorkspace} onSignOut={signOut} />
  }
  const workspace = currentWorkspace.value
  if (!workspace) {
    return <WorkspaceScreen client={client} email={session.user.email ?? ''} onReady={reloadWorkspace} onSignOut={signOut} />
  }
  return <Dashboard key={`${session.user.id}:${workspace.id}`} client={client} workspace={workspace} email={session.user.email ?? ''} userId={session.user.id}
    connection={settings} onSignOut={signOut} />
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
