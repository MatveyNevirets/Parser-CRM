import type { CompanyCard, NormalizedCompany } from './types.ts'
import type { SourceCompanyCard } from './source.ts'

const corporateTokens = new Set(['ооо', 'ао', 'пао', 'оао', 'зао', 'ип', 'нко'])

export function normalizeSourceCompanyCard(
  source: CompanyCard['source'],
  card: SourceCompanyCard,
  receivedAt = new Date().toISOString(),
  candidateId = globalThis.crypto.randomUUID(),
): NormalizedCompany {
  return normalizeCompanyCard({ ...card, source, receivedAt, candidateId })
}

export function normalizeCompanyCard(card: CompanyCard): NormalizedCompany {
  const companyName = cleanText(card.companyName)
  const sourceName = cleanText(card.sourceName) || companyName
  const city = cleanText(card.city)
  const address = cleanNullable(card.address)
  const niche = cleanText(card.niche)
  const phone = cleanNullable(card.phone)
  const website = cleanNullable(card.website)
  const sourceUrl = cleanNullable(card.sourceUrl)
  const sourceCardId = cleanNullable(card.sourceCardId)
  const sourceNetworkId = cleanNullable(card.sourceNetworkId)
  const normalizedName = normalizeName(companyName)
  const normalizedCity = normalizeText(city)
  const normalizedAddress = address ? normalizeText(address) : null
  const normalizedPhone = phone ? normalizePhone(phone) : null
  const normalizedDomain = website ? normalizeDomain(website) : null
  const canonicalSourceUrl = sourceUrl ? canonicalizeUrl(sourceUrl) : null
  const validationErrors: string[] = []

  if (!companyName) validationErrors.push('Название компании не указано.')
  if (!city) validationErrors.push('Город не указан.')
  if (!niche) validationErrors.push('Ниша не указана.')
  if (phone && !normalizedPhone) validationErrors.push('Телефон не удалось нормализовать.')
  if (website && !normalizedDomain) validationErrors.push('Ссылка на сайт имеет неверный формат.')
  if (sourceUrl && !canonicalSourceUrl) validationErrors.push('Ссылка на карточку имеет неверный формат.')
  if (card.rating !== null && (!Number.isFinite(card.rating) || card.rating < 0 || card.rating > 5)) {
    validationErrors.push('Рейтинг должен быть числом от 0 до 5.')
  }
  if (card.reviewCount !== null && (!Number.isInteger(card.reviewCount) || card.reviewCount < 0)) {
    validationErrors.push('Количество отзывов должно быть целым неотрицательным числом.')
  }
  if (card.latitude !== null && (!Number.isFinite(card.latitude) || card.latitude < -90 || card.latitude > 90)) {
    validationErrors.push('Широта находится вне допустимого диапазона.')
  }
  if (card.longitude !== null && (!Number.isFinite(card.longitude) || card.longitude < -180 || card.longitude > 180)) {
    validationErrors.push('Долгота находится вне допустимого диапазона.')
  }

  const dedupeKey = sourceCardId
    ? `${card.source}:id:${sourceCardId}`
    : canonicalSourceUrl ? `${card.source}:url:${canonicalSourceUrl}` : null

  return {
    ...card,
    sourceName,
    companyName,
    city,
    address,
    niche,
    phone,
    website,
    sourceUrl: canonicalSourceUrl,
    sourceCardId,
    sourceNetworkId,
    normalizedName,
    normalizedCity,
    normalizedAddress,
    normalizedPhone,
    normalizedDomain,
    dedupeKey,
    validationErrors,
  }
}

export function normalizePhone(value: string): string | null {
  let digits = value.normalize('NFKC').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`
  return digits.length >= 7 && digits.length <= 15 ? digits : null
}

export function normalizeDomain(value: string): string | null {
  const input = value.trim()
  if (!input) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.toLocaleLowerCase('en-US').replace(/^www\d*\./, '').replace(/\.$/, '')
    return host.includes('.') ? host : null
  } catch {
    return null
  }
}

export function normalizeName(value: string): string {
  const tokens = normalizeText(value).split(' ').filter(Boolean)
  while (tokens.length && corporateTokens.has(tokens[0])) tokens.shift()
  while (tokens.length && corporateTokens.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU')
    .replace(/[«»„“”"'`]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().replace(/\s+/g, ' ')
}

function canonicalizeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hostname = url.hostname.toLocaleLowerCase('en-US').replace(/^www\d*\./, '')
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|yclid|clid)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '')
  } catch {
    return null
  }
}

function cleanText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function cleanNullable(value: string | null): string | null {
  const cleaned = value?.normalize('NFKC').trim().replace(/\s+/g, ' ')
  return cleaned || null
}
