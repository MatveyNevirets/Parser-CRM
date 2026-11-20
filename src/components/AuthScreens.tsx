import { useState, type FormEvent } from 'react'
import { AuthApiError, type SupabaseClient } from '@supabase/supabase-js'
import { KeyRound, Leaf, LogOut, UsersRound } from 'lucide-react'
import { withTimeout } from '../lib/errors'

export function LoginScreen({ client, initialError }: {
  client: SupabaseClient; initialError?: string
}) {
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem('pahota.email') ?? '' }
    catch { return '' }
  })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const login = email.trim()
    setBusy(true); setError(null)
    try {
      const { error: authError } = await withTimeout(client.auth.signInWithPassword({ email: login, password }))
      if (authError) throw authError
      setPassword('')
      try { localStorage.setItem('pahota.email', login) }
      catch { /* Remembering the login is optional. */ }
    } catch (caught) {
      if (caught instanceof AuthApiError && caught.code === 'invalid_credentials') {
        setError('Неверный email или пароль.')
      } else if (caught instanceof AuthApiError && caught.code === 'email_not_confirmed') {
        setError('Подтвердите email, чтобы войти.')
      } else {
        setError('Не удалось войти. Попробуйте ещё раз или обратитесь к администратору.')
      }
    }
    finally { setBusy(false) }
  }
  return <AuthLayout icon={<KeyRound />} title="Вход в Pahota CRM"
    subtitle="Введите email и пароль своего аккаунта CRM.">
    <form onSubmit={submit} className="auth-form">
      <Field label="Логин (email)" value={email} onChange={setEmail} type="email" autoComplete="username"
        required disabled={busy} />
      <Field label="Пароль" value={password} onChange={setPassword} type="password" autoComplete="current-password"
        required disabled={busy} />
      {error && <ErrorBox text={error} />}
      <button className="button primary" type="submit" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
    </form>
  </AuthLayout>
}

export function WorkspaceErrorScreen({ onRetry, onSignOut }: {
  onRetry: () => void; onSignOut: () => void
}) {
  return <AuthLayout icon={<UsersRound />} title="Не удалось загрузить команду"
    subtitle="Вы вошли в CRM. Попробуйте загрузить команду ещё раз.">
    <div className="auth-form">
      <button className="button primary" onClick={onRetry}>Повторить</button>
      <button className="button text danger-text" onClick={onSignOut}><LogOut size={16} /> Выйти</button>
    </div>
  </AuthLayout>
}

export function WorkspaceScreen({ client, email, onReady, onSignOut }: {
  client: SupabaseClient; email: string
  onReady: () => void; onSignOut: () => void
}) {
  const [name, setName] = useState('Наша команда')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const perform = async (mode: 'create' | 'join') => {
    setBusy(true); setError(null)
    const fallback = mode === 'create' ? 'Не удалось создать команду.' : 'Не удалось присоединиться к команде.'
    try {
      const { error: rpcError } = mode === 'create'
        ? await withTimeout(client.rpc('create_workspace', { team_name: name.trim() }))
        : await withTimeout(client.rpc('join_workspace', { invite: code.trim().toLowerCase() }))
      if (rpcError) {
        setError(rpcError.code === 'P0001' ? rpcError.message : fallback)
        return
      }
      onReady()
    } catch { setError(fallback) }
    finally { setBusy(false) }
  }
  return <AuthLayout icon={<UsersRound />} title="Ваша команда"
    subtitle={`Вы вошли как ${email}. Создайте команду или введите код приглашения.`}>
    <div className="auth-form">
      <Field label="Название команды" value={name} onChange={setName} disabled={busy} />
      <button className="button primary" disabled={busy || !name.trim()} onClick={() => void perform('create')}>Создать команду</button>
      <div className="or"><span>или</span></div>
      <Field label="Код команды от друга" value={code} onChange={setCode} disabled={busy} />
      <button className="button secondary" disabled={busy || !code.trim()} onClick={() => void perform('join')}>Присоединиться</button>
      {error && <ErrorBox text={error} />}
      <button className="button text" disabled={busy} onClick={onReady}>Обновить доступ к команде</button>
      <button className="button text danger-text" disabled={busy} onClick={onSignOut}><LogOut size={16} /> Выйти</button>
    </div>
  </AuthLayout>
}

function AuthLayout({ icon, title, subtitle, children }: {
  icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode
}) {
  return <main className="center-page"><section className="auth-card">
    <div className="auth-logo"><div className="brand-mark"><Leaf /></div><div><strong>Pahota</strong><span>CRM</span></div></div>
    <div className="auth-icon">{icon}</div><h1>{title}</h1><p className="auth-subtitle">{subtitle}</p>{children}
  </section></main>
}

function Field({ label, value, onChange, disabled, type = 'text', autoComplete, required }: {
  label: string; value: string; onChange: (value: string) => void
  disabled?: boolean; type?: string; autoComplete?: string; required?: boolean
}) {
  return <label className="field"><span>{label}</span><input value={value}
    disabled={disabled} type={type} autoComplete={autoComplete} required={required}
    onChange={(event) => onChange(event.target.value)} /></label>
}

function ErrorBox({ text }: { text: string }) { return <div className="error-box" role="alert">{text}</div> }
