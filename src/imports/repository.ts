import type { SupabaseClient } from '@supabase/supabase-js'
import { withTimeout } from '../lib/errors'
import type { ImportCandidate } from './types.ts'
import type { PublicationReport } from './service.ts'
import { hasCandidateWebsite, isEligibleForReview } from './review.ts'

export interface PublicationPreview {
  toCreate: number
  alreadyExists: number
  excluded: number
  selected: number
}

/** Published-company niches are read from the existing CRM directory; there is no second niche catalog. */
export async function getExistingNiches(client: SupabaseClient, workspaceId: string): Promise<string[]> {
  const { data, error } = await withTimeout(client.from('leads').select('niche')
    .eq('workspace_id', workspaceId).eq('is_deleted', false).order('niche').limit(1000))
  if (error) throw error
  return [...new Set((data ?? []).map((row) => row.niche?.trim()).filter((value): value is string => Boolean(value)))].sort()
}

/** Read-only server check. It does not create, update, or delete a lead. */
export async function previewLocalImportPublication(
  client: SupabaseClient,
  workspaceId: string,
  source: string,
  selected: ImportCandidate[],
  excludedCount: number,
  excludeWithWebsite = true,
): Promise<PublicationPreview> {
  const { data, error } = await withTimeout(client.rpc('preview_local_import_publication', {
    p_workspace_id: workspaceId,
    p_source: source,
    p_candidates: validatedPublicationPayload(selected, excludeWithWebsite),
    p_excluded_count: excludedCount,
    p_exclude_with_website: excludeWithWebsite,
  }))
  if (error) throw error
  const result = data as Record<string, unknown>
  return {
    toCreate: Number(result.to_create ?? 0),
    alreadyExists: Number(result.already_exists ?? 0),
    excluded: Number(result.excluded ?? 0),
    selected: Number(result.selected ?? 0),
  }
}

/** Called only from the explicit confirmation action. RLS identity is the current user's Supabase session. */
export async function publishLocalImportCandidates(
  client: SupabaseClient,
  workspaceId: string,
  source: string,
  idempotencyKey: string,
  selected: ImportCandidate[],
  excludedCount: number,
  excludeWithWebsite = true,
): Promise<PublicationReport> {
  const { data, error } = await withTimeout(client.rpc('publish_local_import_candidates', {
    p_workspace_id: workspaceId,
    p_source: source,
    p_idempotency_key: idempotencyKey,
    p_confirmed: true,
    p_candidates: validatedPublicationPayload(selected, excludeWithWebsite),
    p_excluded_count: excludedCount,
    p_exclude_with_website: excludeWithWebsite,
  }), 30_000)
  if (error) throw error
  return fromReport(data)
}

function validatedPublicationPayload(selected: ImportCandidate[], excludeWithWebsite: boolean) {
  if (!selected.length) throw new Error('Нет карточек, готовых к публикации.')
  if (excludeWithWebsite && selected.some(hasCandidateWebsite)) throw new Error('В выбранных карточках найден сайт.')
  if (selected.some((candidate) => candidate.userDecision !== 'include' || candidate.importStatus !== 'ready'
    || !isEligibleForReview(candidate, excludeWithWebsite))) {
    throw new Error('Проверьте ошибки данных, дубли и решения о включении.')
  }
  return selected.map(toPublicationPayload)
}

function toPublicationPayload(candidate: ImportCandidate) {
  return {
    source: candidate.source,
    candidate_id: candidate.candidateId,
    source_card_id: candidate.sourceCardId,
    company_name: candidate.companyName,
    city: candidate.city,
    address: candidate.address,
    niche: candidate.niche,
    phone: candidate.phone,
    website: candidate.website?.trim() && !/^https?:\/\//i.test(candidate.website)
      ? `https://${candidate.website.trim()}` : candidate.website,
    website_check_status: candidate.websiteCheckStatus ?? 'unknown',
    website_check_version: candidate.websiteCheckVersion ?? null,
    website_checked_at: candidate.websiteCheckedAt ?? null,
    website_checked_source_url: candidate.websiteCheckedSourceUrl ?? null,
    source_url: candidate.sourceUrl,
    user_decision: candidate.userDecision,
    import_status: candidate.importStatus,
    validation_errors: candidate.validationErrors,
    duplicate_kind: candidate.duplicateKind,
    branch_classification: candidate.branchClassification,
    branch_override: candidate.branchOverride,
  }
}

function fromReport(value: unknown): PublicationReport {
  if (!value || typeof value !== 'object') throw new Error('Сервер вернул некорректный отчёт публикации.')
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.items)) throw new Error('В отчёте публикации нет списка обработанных карточек.')
  const status = row.status === 'completed' ? 'completed' : row.status === 'partially_completed' ? 'partially_completed' : null
  if (!status) throw new Error('Сервер вернул неизвестный статус публикации.')
  return {
    created: Number(row.created ?? 0),
    alreadyExists: Number(row.already_exists ?? 0),
    excluded: Number(row.excluded ?? 0),
    failed: Number(row.failed ?? 0),
    status,
    items: row.items.map((item) => {
      const result = item as Record<string, unknown>
      return {
        candidateId: String(result.candidate_id),
        leadId: typeof result.lead_id === 'string' ? result.lead_id : null,
        status: result.status as 'created' | 'already_exists' | 'failed',
        reason: typeof result.reason === 'string' ? result.reason.slice(0, 500) : null,
      }
    }),
  }
}
