import type { LocalCollectRequest, LocalJobSnapshot, LocalResultPage } from './contracts.ts'
import { TwoGisLocalJob } from './twoGisMaps.ts'
import type { SourceCompanyCard } from '../../src/imports/source.ts'

/** Local source session port; collectors expose cards and paging, not browser/DOM objects. */
export interface LocalCollectionSession {
  readonly runId: string
  readonly canContinue: boolean
  start(): Promise<LocalJobSnapshot>
  nextPage(): Promise<LocalResultPage | null>
  acknowledge(pageId: string): LocalJobSnapshot
  continue(additionalPages: number, additionalCandidates: number): Promise<LocalJobSnapshot>
  cancel(): Promise<LocalJobSnapshot>
  dispose(): Promise<void>
  snapshot(): LocalJobSnapshot
}

export interface LocalCollectionSource {
  createSession(request: LocalCollectRequest, onCard?: (card: SourceCompanyCard) => void): LocalCollectionSession
}

/** Playwright is confined to this provider adapter; the orchestration layer only sees the port. */
export class TwoGisLocalSource implements LocalCollectionSource {
  createSession(request: LocalCollectRequest, onCard?: (card: SourceCompanyCard) => void): LocalCollectionSession {
    return new TwoGisLocalJob(request, onCard)
  }
}
