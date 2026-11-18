import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const storageKey = 'pahota.connection.v1'

export interface ConnectionSettings { url: string; key: string }

export function readSettings(): ConnectionSettings | null {
  const envUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (envUrl && envKey) return { url: envUrl.replace(/\/$/, ''), key: envKey }
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as ConnectionSettings | null
    return value && !validateSettings(value) ? value : null
  } catch { return null }
}

export function validateSettings(settings: ConnectionSettings): string | null {
  try {
    const url = new URL(settings.url)
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error()
  } catch { return 'Укажите HTTPS Project URL, например https://abc.supabase.co' }
  if (settings.key.startsWith('sb_secret_') || settings.key.includes('service_role')) {
    return 'Секретный/service_role ключ нельзя использовать в браузере. Нужен Publishable key.'
  }
  if (settings.key.startsWith('sb_publishable_') && settings.key.length > 25) return null
  try {
    const parts = settings.key.split('.')
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string }
      if (payload.role === 'anon') return null
    }
  } catch { /* handled below */ }
  return 'Нужен Publishable key (sb_publishable_…) или legacy anon key.'
}

export function saveSettings(settings: ConnectionSettings): void {
  const error = validateSettings(settings)
  if (error) throw new Error(error)
  localStorage.setItem(storageKey, JSON.stringify(settings))
}

export function clearSettings(): void { localStorage.removeItem(storageKey) }

export function makeClient(settings: ConnectionSettings): SupabaseClient {
  return createClient(settings.url, settings.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 5 } },
  })
}
