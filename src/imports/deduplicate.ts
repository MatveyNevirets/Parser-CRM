import type { DuplicateClassification, NormalizedCompany } from './types.ts'

/** Keeps every row for audit while marking one canonical row in each duplicate group. */
export function classifyDuplicates(candidates: NormalizedCompany[]): DuplicateClassification[] {
  const result = candidates.map((candidate) => ({
    candidate,
    duplicateOfId: null as string | null,
    duplicateKind: null as 'exact' | 'possible' | null,
  }))

  markGroups(result, (candidate) => candidate.dedupeKey, 'exact')
  markGroups(result, (candidate) => {
    if (!candidate.normalizedName || !candidate.normalizedCity || !candidate.normalizedAddress || !candidate.normalizedPhone) return null
    return [candidate.normalizedName, candidate.normalizedCity, candidate.normalizedAddress, candidate.normalizedPhone].join('|')
  }, 'possible')

  return result
}

function markGroups(
  rows: DuplicateClassification[],
  getKey: (candidate: NormalizedCompany) => string | null,
  kind: 'exact' | 'possible',
): void {
  const buckets = new Map<string, DuplicateClassification[]>()
  for (const row of rows) {
    if (row.duplicateOfId) continue
    const key = getKey(row.candidate)
    if (!key) continue
    const bucket = buckets.get(key) ?? []
    bucket.push(row)
    buckets.set(key, bucket)
  }

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    const ranked = [...bucket].sort((a, b) => completeness(b.candidate) - completeness(a.candidate)
      || a.candidate.candidateId.localeCompare(b.candidate.candidateId))
    const keeper = ranked[0]
    for (const duplicate of ranked.slice(1)) {
      duplicate.duplicateOfId = keeper.candidate.candidateId
      duplicate.duplicateKind = kind
    }
  }
}

function completeness(candidate: NormalizedCompany): number {
  return [candidate.address, candidate.normalizedPhone, candidate.website, candidate.sourceUrl,
    candidate.rating, candidate.reviewCount, candidate.latitude, candidate.longitude]
    .filter((value) => value !== null && value !== '').length
}
