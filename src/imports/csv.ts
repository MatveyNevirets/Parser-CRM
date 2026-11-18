import type { ImportCandidate } from './types.ts'

const headers = [
  'Название', 'Ниша', 'Город', 'Адрес', 'Телефон', 'Сайт', 'Ссылка на карточку', 'Источник',
  'Статус проверки', 'Признак дубликата', 'ID группы филиалов', 'Причина исключения', 'Готовность к импорту',
]

export function importCandidatesToCsv(candidates: ImportCandidate[]): string {
  const rows = candidates.map((candidate) => [
    candidate.companyName,
    candidate.niche,
    candidate.city,
    candidate.address ?? '',
    candidate.phone ?? '',
    candidate.website ?? '',
    candidate.sourceUrl ?? '',
    candidate.source,
    reviewStatus(candidate),
    candidate.duplicateKind ?? '',
    candidate.branchGroupKey ?? '',
    candidate.exclusionReason ?? candidate.validationErrors.join('; '),
    candidate.importStatus === 'ready' ? 'Готова' : 'Не готова',
  ])
  const encode = (value: string) => {
    const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value
    return `"${safeValue.replace(/"/g, '""')}"`
  }
  return `\uFEFF${[headers, ...rows].map((row) => row.map(encode).join(',')).join('\r\n')}`
}

function reviewStatus(candidate: ImportCandidate): string {
  if (candidate.validationErrors.length) return 'Ошибка данных'
  if (candidate.branchClassification === 'confirmed' && candidate.branchOverride !== 'independent') return 'Филиальная сеть'
  if (candidate.branchClassification === 'needs_review' && candidate.branchOverride !== 'independent') return 'Требует проверки'
  if (candidate.duplicateKind === 'exact') return 'Точный дубликат'
  if (candidate.duplicateKind === 'possible') return 'Вероятный дубликат'
  if (candidate.userDecision === 'exclude') return 'Исключена'
  return candidate.userDecision === 'include' ? 'Включена пользователем' : 'Ожидает проверки'
}
