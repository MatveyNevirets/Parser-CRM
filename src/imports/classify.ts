import { classifyBranchGroups } from './branches.ts'
import { classifyDuplicates } from './deduplicate.ts'
import type { ClassifiedCompany, NormalizedCompany } from './types.ts'

/** Attaches duplicate and branch signals without deleting any source record. */
export function classifyCompanies(candidates: NormalizedCompany[]): ClassifiedCompany[] {
  const duplicates = classifyDuplicates(candidates)
  const branches = classifyBranchGroups(candidates)
  const branchByCandidate = new Map(branches.flatMap((group) => group.memberIds.map((id) => [id, group] as const)))

  return duplicates.map(({ candidate, duplicateOfId, duplicateKind }) => {
    const group = branchByCandidate.get(candidate.candidateId)
    return {
      ...candidate,
      duplicateOfId,
      duplicateKind,
      branchGroupKey: group?.groupKey ?? null,
      branchClassification: group?.classification ?? 'none',
      branchEvidence: group?.evidence ?? [],
    }
  })
}
