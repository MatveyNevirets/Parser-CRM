export type ImportSource = 'yandex_maps' | '2gis' | (string & {})

export type ImportRunStatus =
  | 'created'
  | 'collecting'
  | 'ready_for_review'
  | 'approved'
  | 'importing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'needs_attention'
  | 'partially_completed'
  | 'rejected'

export type ResultCompleteness = 'unknown' | 'complete' | 'partial'
export type PublicationStatus = 'not_started' | 'approved' | 'importing' | 'completed' | 'partially_completed' | 'rejected'
export type BranchClassification = 'none' | 'needs_review' | 'confirmed' | 'independent'
export type CandidateDecision = 'pending' | 'include' | 'exclude'
export type CandidateImportStatus = 'not_ready' | 'ready' | 'imported' | 'skipped_existing' | 'failed'
export type BranchOverride = 'unreviewed' | 'independent' | 'confirmed'

export interface ImportRunParameters {
  workspaceId: string
  source: ImportSource
  city: string
  niche: string
  requestedCount: number
  excludeWithWebsite?: boolean
}

export interface ImportRun extends ImportRunParameters {
  id: string
  automaticCollection?: boolean
  createdBy: string
  status: ImportRunStatus
  publicationStatus: PublicationStatus
  completeness: ResultCompleteness
  startedAt: string | null
  finishedAt: string | null
  rawFound: number
  storedCount: number
  uniqueCount: number
  exactDuplicateCount: number
  possibleDuplicateCount: number
  branchGroupCount: number
  invalidCount: number
  needsReviewCount: number
  existingCount: number
  readyCount: number
  importedCount: number
  publicationIdempotencyKey: string | null
  sourceCursor: unknown | null
  currentPage: number
  classifiedPage: number
  excludedCount: number
  stopReason: string | null
  errorMessage: string | null
}

/** Source-neutral representation of one business card. Source payloads are deliberately not retained. */
export interface CompanyCard {
  candidateId: string
  source: ImportSource
  sourceCardId: string | null
  sourceNetworkId: string | null
  sourceName: string
  companyName: string
  city: string
  address: string | null
  niche: string
  phone: string | null
  website: string | null
  /** Missing on legacy drafts; an empty website alone is not evidence of absence. */
  websiteCheckStatus?: 'present' | 'absent' | 'unknown'
  websiteCheckVersion?: number
  websiteCheckedAt?: string
  websiteCheckedSourceUrl?: string
  sourceUrl: string | null
  rating: number | null
  reviewCount: number | null
  latitude: number | null
  longitude: number | null
  receivedAt: string
}

export interface NormalizedCompany extends CompanyCard {
  normalizedName: string
  normalizedCity: string
  normalizedAddress: string | null
  normalizedPhone: string | null
  normalizedDomain: string | null
  dedupeKey: string | null
  validationErrors: string[]
}

export interface ClassifiedCompany extends NormalizedCompany {
  duplicateOfId: string | null
  duplicateKind: 'exact' | 'possible' | null
  branchGroupKey: string | null
  branchClassification: BranchClassification
  branchEvidence: string[]
}

export interface DuplicateClassification {
  candidate: NormalizedCompany
  duplicateOfId: string | null
  duplicateKind: 'exact' | 'possible' | null
}

export interface BranchGroup {
  groupKey: string
  memberIds: string[]
  classification: 'needs_review' | 'confirmed'
  evidence: string[]
}

export interface ImportCandidate extends NormalizedCompany {
  runId: string
  validationErrors: string[]
  duplicateOfId: string | null
  duplicateKind: 'exact' | 'possible' | null
  branchGroupKey: string | null
  branchClassification: BranchClassification
  branchOverride: BranchOverride
  branchEvidence: string[]
  userDecision: CandidateDecision
  importStatus: CandidateImportStatus
  importedLeadId: string | null
  exclusionReason: string | null
}
