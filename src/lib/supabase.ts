import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface ConnectionSettings { url: string; key: string; configurationError?: string }

// Public connection settings for the release, also available in its browser bundle.
const publishedSettings: ConnectionSettings = {
  url: 'https://lpnpjezjzlmjkehdldtg.supabase.co',
  key: 'sb_publishable_gxKesbYjrpbYuWs9WKNhAQ_RIZLQz6k',
}

export function readSettings(): ConnectionSettings {
  const envUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!envUrl && !envKey) return publishedSettings

  const settings = { url: (envUrl ?? '').replace(/\/$/, ''), key: envKey ?? '' }
  const configurationError = validateSettings(settings)
  return configurationError ? { ...publishedSettings, configurationError } : settings
}

function validateSettings(settings: ConnectionSettings): string | null {
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

export function makeClient(settings: ConnectionSettings): SupabaseClient {
  return createClient(settings.url, settings.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 5 } },
  })
}
