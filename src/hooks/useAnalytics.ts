import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage, withTimeout } from '../lib/errors'

export function useActivityRevision(client: SupabaseClient, workspaceId: string) {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    const channel = client.channel(`crm-activity:${workspaceId}`).on('postgres_changes', {
      event: '*', schema: 'public', table: 'crm_activity_updates', filter: `workspace_id=eq.${workspaceId}`,
    }, refresh).subscribe((status) => { if (status === 'SUBSCRIBED') refresh() })
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      void client.removeChannel(channel)
    }
  }, [client, workspaceId])
  return revision
}

export function useAnalytics<T>(
  client: SupabaseClient, rpc: string, params: Record<string, string | number>, revision: number,
) {
  const key = JSON.stringify(params)
  const [result, setResult] = useState<{ key: string; data: T | null; error: string }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    void withTimeout(client.rpc(rpc, JSON.parse(key))).then(({ data, error }) => {
      if (error) throw error
      if (active) setResult({ key, data: data as T, error: '' })
    }).catch((error) => {
      if (active) setResult((previous) => ({ key, data: previous?.key === key ? previous.data : null, error: getErrorMessage(error) }))
    })
    return () => { active = false }
  }, [client, key, revision, retry, rpc])
  const current = result?.key === key ? result : undefined
  return { data: current?.data ?? null, error: current?.error ?? '', refresh: () => setRetry((value) => value + 1) }
}
