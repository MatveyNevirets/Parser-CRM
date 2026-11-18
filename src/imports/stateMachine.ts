import type { ImportRunStatus } from './types.ts'

const transitions: Record<ImportRunStatus, readonly ImportRunStatus[]> = {
  created: ['collecting', 'cancelled', 'failed'],
  collecting: ['ready_for_review', 'partially_completed', 'needs_attention', 'cancelled', 'failed'],
  ready_for_review: ['approved', 'rejected', 'cancelled'],
  approved: ['importing', 'rejected', 'cancelled'],
  importing: ['completed', 'partially_completed', 'failed'],
  completed: [],
  cancelled: [],
  failed: ['ready_for_review', 'cancelled'],
  needs_attention: ['collecting', 'ready_for_review', 'partially_completed', 'cancelled', 'failed'],
  partially_completed: ['collecting', 'ready_for_review', 'approved', 'cancelled', 'failed'],
  rejected: [],
}

export function canTransitionImportRun(current: ImportRunStatus, next: ImportRunStatus): boolean {
  return current === next || transitions[current].includes(next)
}

/** Repeating the current state is idempotent; all other invalid jumps are rejected. */
export function transitionImportRun(current: ImportRunStatus, next: ImportRunStatus): ImportRunStatus {
  if (!canTransitionImportRun(current, next)) {
    throw new Error(`Недопустимый переход запуска импорта: ${current} → ${next}.`)
  }
  return next
}

export function availableImportRunTransitions(current: ImportRunStatus): readonly ImportRunStatus[] {
  return transitions[current]
}
