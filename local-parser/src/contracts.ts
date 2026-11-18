import type { SourceCompanyCard } from '../../src/imports/source.ts'

export type LocalJobStatus = 'starting' | 'collecting' | 'needs_attention' | 'ready_for_review' | 'partially_completed' | 'cancelled' | 'failed'

export interface LocalCollectRequest {
  runId: string
  city: string
  niche: string
  requestedCount: number
  maxPages?: number
  maxCandidates?: number
  knownCardIds?: string[]
  startPage?: number
}

export interface LocalResultPage {
  pageId: string
  pageIndex: number
  cards: SourceCompanyCard[]
  hasMore: boolean
  sourceComplete: boolean
  reportedTotal: null
  limitations: string[]
  stopReason: string | null
}

export interface LocalJobSnapshot {
  jobId: string
  runId: string
  status: LocalJobStatus
  pageIndex: number
  rawFound: number
  message: string | null
  stopReason: string | null
  canContinue: boolean
}
