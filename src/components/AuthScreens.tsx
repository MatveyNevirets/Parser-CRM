import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Database, KeyRound, Leaf, LogOut, UsersRound } from 'lucide-react'
import { getErrorMessage, withTimeout } from '../lib/errors'
import { validateSettings, type ConnectionSettings } from '../lib/supabase'

interface ConnectionProps { onConnect: (settings: ConnectionSettings) => void }

export function ConnectionScreen({ onConnect }: ConnectionProps) {
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const settings = { url: url.trim().replace(/\/$/, ''), key: key.trim() }
    const validation = validateSettings(settings)
    if (validation) { setError(validation); return }
    onConnect(settings)
  }
  return <AuthLayout icon={<Database />} title="Подключение Pahota CRM"
    subtitle="Один проект Supabase для всей команды. Параметры сохранятся в этом браузере.">
    <form onSubmit={submit} className="auth-form">
      <Field label="Project URL" value={url} onChange={setUrl} placeholder="https://abc.supabase.co" />
      <Field label="Publishable / anon key" value={key} onChange={setKey} secret />
      {error && <ErrorBox text={error} />}
      <button className="button primary" type="submit">Сохранить и продолжить</button>
      <p className="form-note">Перед подключением выполните SQL-миграцию из README. Secret и service_role ключи сюда вводить нельзя.</p>
    </form>
  </AuthLayout>
}

export function LoginScreen({ client, initialError, onReset }: {
  client: SupabaseClient; initialError: string | null; onReset: () => void
}) {
  const [email, setEmail] = useState(() => localStorage.getItem('pahota.email') ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const { error: authError } = await withTimeout(client.auth.signInWithPassword({ email: email.trim(), password }))
      if (authError) throw authError
      localStorage.setItem('pahota.email', email.trim())
      setPassword('')
    } catch (caught) { setError(getErrorMessage(caught)) }
    finally { setBusy(false) }
  }
  return <AuthLayout icon={<KeyRound />} title="Вход в Pahota CRM"
    subtitle="Используйте личный аккаунт CRM, созданный в Supabase Authentication → Users.">
    <form onSubmit={submit} className="auth-form">
      <Field label="Email" value={email} onChange={setEmail} type="email" disabled={busy} />
      <Field label="Пароль" value={password} onChange={setPassword} secret disabled={busy} />
      {error && <ErrorBox text={error} />}
      <button className="button primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
      <p className="form-note">Вход сохранится на этом устройстве. Пароль от панели Supabase здесь не используется.</p>
      <button className="button text" type="button" disabled={busy} onClick={onReset}>Изменить подключение к Supabase</button>
    </form>
  </AuthLayout>
}

export function WorkspaceScreen({ client, email, initialError, onReady, onSignOut }: {
  client: SupabaseClient; email: string; initialError: string | null
  onReady: () => void; onSignOut: () => void
}) {
  const [name, setName] = useState('Наша команда')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const perform = async (mode: 'create' | 'join') => {
    setBusy(true); setError(null)
    try {
      const { error: rpcError } = mode === 'create'
        ? await withTimeout(client.rpc('create_workspace', { team_name: name.trim() }))
        : await withTimeout(client.rpc('join_workspace', { invite: code.trim().toLowerCase() }))
      if (rpcError) throw rpcError
      onReady()
    } catch (caught) { setError(getErrorMessage(caught)) }
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

function Field({ label, value, onChange, placeholder, secret, disabled, type }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string
  secret?: boolean; disabled?: boolean; type?: string
}) {
  return <label className="field"><span>{label}</span><input value={value} placeholder={placeholder}
    disabled={disabled} type={secret ? 'password' : type ?? 'text'} autoComplete={secret ? 'current-password' : undefined}
    onChange={(event) => onChange(event.target.value)} /></label>
}

function ErrorBox({ text }: { text: string }) { return <div className="error-box" role="alert">{text}</div> }
