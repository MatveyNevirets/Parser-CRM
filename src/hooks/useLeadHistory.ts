import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage, withTimeout } from '../lib/errors'

const pageSize = 20

export function useLeadHistory<T extends { id: string }>(
  client: SupabaseClient, table: 'lead_calls' | 'lead_outreach', leadId: string,
) {
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<T[] | null>(null)
  const [error, setError] = useState('')
  const [request, setRequest] = useState(0)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    let active = true
    const from = page * pageSize
    void withTimeout(client.from(table).select(table === 'lead_outreach' ? 'id,kind,occurred_at' : '*').eq('lead_id', leadId)
      .order('occurred_at', { ascending: false }).order('id').range(from, from + pageSize))
      .then(({ data, error: failure }) => {
        if (failure) throw failure
        if (!active) return
        const next = data.slice(0, pageSize) as unknown as T[]
        setRows((current) => page === 0 ? next : [...(current ?? []),
          ...next.filter((row) => !current?.some((previous) => previous.id === row.id))])
        setMore(data.length > pageSize)
        setError('')
      })
      .catch((failure) => { if (active) setError(getErrorMessage(failure)) })
      .finally(() => { if (active) setLoadingMore(false) })
    return () => { active = false }
  }, [client, table, leadId, page, request])
  return { rows, error, more, loadingMore,
    refresh: () => { setPage(0); setRequest((value) => value + 1) },
    loadMore: () => { if (!loadingMore) { setLoadingMore(true); setPage((value) => value + 1) } },
  }
}
