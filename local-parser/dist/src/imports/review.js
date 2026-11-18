/** Stopping collection preserves a reviewable draft; rejecting publication closes it. */
export function isReviewableImportRun(run) {
    return run.publicationStatus === 'not_started'
        && ['collecting', 'ready_for_review', 'partially_completed', 'needs_attention', 'cancelled', 'failed'].includes(run.status);
}
export function hasCandidateWebsite(candidate) {
    return Boolean(candidate.website?.trim()) || candidate.websiteCheckStatus === 'present';
}
export function isEligibleForReview(candidate, excludeWithWebsite = true) {
    const blockedBranch = ['confirmed', 'needs_review'].includes(candidate.branchClassification) && candidate.branchOverride !== 'independent';
    return !candidate.validationErrors.length && candidate.duplicateKind === null && !blockedBranch
        && (!excludeWithWebsite || !hasCandidateWebsite(candidate))
        && !['imported', 'skipped_existing'].includes(candidate.importStatus);
}
export function isSelectableForBulkReview(candidate, excludeWithWebsite = true) {
    return candidate.userDecision !== 'exclude' && (!excludeWithWebsite || !hasCandidateWebsite(candidate))
        && !['imported', 'skipped_existing'].includes(candidate.importStatus);
}
