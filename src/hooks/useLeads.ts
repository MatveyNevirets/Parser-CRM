import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage, withTimeout } from '../lib/errors'
import type { Lead, LeadDraft, LeadStatus } from '../types'

type StoredLead = Omit<Lead, 'status'> & { status: LeadStatus | 'contacted' | 'qualified' }

export class LeadConflictError extends Error {
  constructor() {
    super('Карточка уже изменена или удалена вашим коллегой. Закройте редактор и откройте актуальную карточку. Ваш текст пока остаётся в форме.')
  }
}

export function useLeads(client: SupabaseClient, workspaceId: string) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const mounted = useRef(true)
  const refreshing = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)

  const refresh = useCallback(() => {
    if (refreshing.current) {
      refreshAgain.current = true
      return refreshing.current
    }
    const load = async () => {
      do {
        refreshAgain.current = false
        try {
          const result: Lead[] = []
          for (let offset = 0; ; offset += 500) {
            const { data, error: queryError } = await withTimeout(client.from('leads').select('*')
              .eq('workspace_id', workspaceId).eq('is_deleted', false)
              .order('id').range(offset, offset + 499))
            if (queryError) throw queryError
            for (const lead of data as StoredLead[]) {
              result.push({ ...lead, status: lead.status === 'contacted' || lead.status === 'qualified' ? 'inProgress' : lead.status })
            }
            if (data.length < 500) break
          }
          result.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          if (mounted.current) { setLeads(result); setError(null) }
        } catch (caught) {
          if (mounted.current) setError(getErrorMessage(caught))
        } finally {
          if (mounted.current) setLoading(false)
        }
      } while (refreshAgain.current && mounted.current)
      refreshing.current = null
    }
    refreshing.current = load()
    return refreshing.current
  }, [client, workspaceId])

  useEffect(() => {
    mounted.current = true
    void refresh()
    let channel: RealtimeChannel | null = client.channel(`leads:${workspaceId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'leads', filter: `workspace_id=eq.${workspaceId}`,
      }, () => { void refresh() })
      .subscribe((status) => {
        if (!mounted.current) return
        const connected = status === 'SUBSCRIBED'
        setRealtimeConnected(connected)
        if (connected) void refresh()
      })
    const timer = window.setInterval(() => void refresh(), 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      if (channel) { void client.removeChannel(channel); channel = null }
    }
  }, [client, workspaceId, refresh])

  const addLead = useCallback(async (id: string, draft: LeadDraft) => {
    const { error: queryError } = await withTimeout(client.from('leads').insert({
      id, workspace_id: workspaceId, ...draft,
    }))
    if (queryError) throw queryError
    await refresh()
  }, [client, workspaceId, refresh])

  const updateLead = useCallback(async (lead: Lead, draft: Partial<LeadDraft & Pick<Lead,
    'archived_at' | 'manually_queued_for_calls' | 'excluded_from_automatic_calls'>>) => {
    const { data, error: queryError } = await withTimeout(client.from('leads').update(draft)
      .eq('workspace_id', workspaceId).eq('id', lead.id)
      .eq('version', lead.version).eq('is_deleted', false).select('id'))
    if (queryError) throw queryError
    await refresh()
    if (!data?.length) throw new LeadConflictError()
  }, [client, workspaceId, refresh])

  const deleteLead = useCallback(async (lead: Lead) => {
    const { data, error: queryError } = await withTimeout(client.from('leads').update({ is_deleted: true })
      .eq('workspace_id', workspaceId).eq('id', lead.id)
      .eq('version', lead.version).eq('is_deleted', false).select('id'))
    if (queryError) throw queryError
    await refresh()
    if (!data?.length) throw new LeadConflictError()
  }, [client, workspaceId, refresh])

  return { leads, loading, error, realtimeConnected, refresh, addLead, updateLead, deleteLead }
}
