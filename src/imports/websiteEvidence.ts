import type { CompanyCard } from './types.ts'

export const currentWebsiteCheckVersion = 2
const maxCheckAgeMs = 24 * 60 * 60 * 1000
const maxFutureClockSkewMs = 60 * 1000

type CheckedCompany = Pick<CompanyCard, 'source' | 'sourceCardId' | 'sourceUrl' | 'website' | 'websiteCheckStatus'
  | 'websiteCheckVersion' | 'websiteCheckedAt' | 'websiteCheckedSourceUrl'>

/** A legacy empty field or absent marker is never evidence of a completed check. */
export function hasCurrentNoWebsiteCheck(candidate: CheckedCompany, now = Date.now()): boolean {
  if (candidate.source !== '2gis' || candidate.websiteCheckStatus !== 'absent' || candidate.website?.trim()
    || candidate.websiteCheckVersion !== currentWebsiteCheckVersion || typeof candidate.websiteCheckedAt !== 'string'
    || !candidate.sourceCardId || !candidate.sourceUrl || candidate.websiteCheckedSourceUrl !== candidate.sourceUrl) return false

  const checkedAt = Date.parse(candidate.websiteCheckedAt)
  const age = now - checkedAt
  if (!Number.isFinite(now) || !Number.isFinite(checkedAt) || age < -maxFutureClockSkewMs || age > maxCheckAgeMs) return false

  try {
    const url = new URL(candidate.sourceUrl)
    const firmId = url.pathname.match(/^\/(?:[^/?#]+\/)*firm\/(\d+)$/)?.[1]
    return url.origin === 'https://2gis.ru' && url.href === candidate.sourceUrl && candidate.sourceUrl === `https://2gis.ru${url.pathname}`
      && !url.username && !url.password && !url.search && !url.hash && firmId === candidate.sourceCardId
  } catch { return false }
}
