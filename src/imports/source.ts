import type { CompanyCard, ImportSource } from './types.ts'

export type SourceCompanyCard = Omit<CompanyCard, 'candidateId' | 'receivedAt' | 'source'>

export type SourceFailureCode = 'captcha' | 'access_denied' | 'rate_limited' | 'timeout' | 'network' | 'provider_error'

export class CompanySourceError extends Error {
  constructor(
    message: string,
    readonly code: SourceFailureCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'CompanySourceError'
  }

  get requiresUserAction(): boolean {
    return this.code === 'captcha' || this.code === 'access_denied' || this.code === 'rate_limited'
  }
}

export interface SourceSearchRequest {
  city: string
  niche: string
  requestedCount: number
  pageSize: number
  cursor: unknown | null
  signal: AbortSignal
}

export interface SourceSearchPage {
  cards: SourceCompanyCard[]
  nextCursor: unknown | null
  hasMore: boolean
  sourceComplete: boolean
  reportedTotal: number | null
  limitations: string[]
}

/** Provider adapters return normalized company fields, never provider-specific DOM or raw HTML. */
export interface CompanySource {
  readonly id: ImportSource
  readonly maxPageSize: number
  searchPage(request: SourceSearchRequest): Promise<SourceSearchPage>
}
