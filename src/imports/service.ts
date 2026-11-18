import type { CandidateDecision, ImportCandidate, ImportRun, ImportRunParameters } from './types.ts'

/** Application port shared by the browser transport and a future desktop main process. */
export interface ImportService {
  listRuns(workspaceId: string, limit?: number): Promise<ImportRun[]>
  getRun(workspaceId: string, runId: string): Promise<ImportRun | null>
  listCandidates(workspaceId: string, runId: string, page: number, pageSize: number, search?: string): Promise<ImportCandidatePage>
  startRun(parameters: ImportRunParameters, createdBy: string): Promise<ImportRun>
  collectNextPage(workspaceId: string, runId: string): Promise<ImportRun>
  cancelRun(workspaceId: string, runId: string): Promise<ImportRun>
  rejectRun(workspaceId: string, runId: string): Promise<ImportRun>
  continueRun(workspaceId: string, runId: string): Promise<ImportRun>
  decideCandidates(workspaceId: string, runId: string, candidateIds: string[], decision: CandidateDecision): Promise<void>
  reviewBranchGroup(workspaceId: string, runId: string, groupKey: string, classification: 'independent' | 'confirmed'): Promise<void>
  editCandidate(workspaceId: string, runId: string, candidateId: string, fields: CandidateFields): Promise<ImportCandidate>
  addCandidate(workspaceId: string, runId: string, fields: CandidateFields): Promise<ImportCandidate>
  deleteRun(workspaceId: string, runId: string): Promise<void>
  preparePublication(workspaceId: string, runId: string): Promise<string>
  recordPublication(workspaceId: string, runId: string, report: PublicationReport): Promise<ImportRun>
}

export interface ImportCandidatePage { items: ImportCandidate[]; page: number; pageSize: number; total: number }
export interface CandidateFields { companyName: string; city: string; address: string; niche: string; phone: string; website: string }
export interface PublicationItemResult { candidateId: string; leadId: string | null; status: 'created' | 'already_exists' | 'failed'; reason?: string | null }
export interface PublicationReport { created: number; alreadyExists: number; excluded: number; failed: number; status: 'completed' | 'partially_completed'; items: PublicationItemResult[] }

export interface LocalImportServiceClient extends ImportService {
  health(): Promise<{ ok: true; storage: 'sqlite'; browser: 'local-chromium'; protocolVersion: number }>
}
