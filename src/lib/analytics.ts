export const periods = [
  { key: 'day', label: 'День', totalLabel: 'За сегодня' },
  { key: 'week', label: 'Неделя', totalLabel: 'За неделю' },
  { key: 'month', label: 'Месяц', totalLabel: 'За месяц' },
  { key: 'year', label: 'Год', totalLabel: 'За год' },
] as const
export type Period = (typeof periods)[number]['key']
export type Totals = Record<Period | 'total', number>

export interface Activity {
  today: string
  week_start: string
  zone: string
  counts: Totals
  daily: Record<string, number>
  hourly: Record<string, number>
  earnings: (Totals & { daily: Record<string, number> }) | null
}

export interface EmployeeActivity extends Activity {
  profile: { id: string; login: string; created_at: string | null; is_admin: boolean }
}
export interface TeamActivity extends Activity {
  reconciliation: { cutoff: string; additional: number } | null
}
export interface Employee {
  id: string; login: string; today: number; total: number; earnings: number; last_activity: string | null
}
export interface Earning {
  id: string; earned_on: string; amount_kopecks: number; comment: string
  lead_id: string | null; company_name: string | null; version: number
}

export const number = new Intl.NumberFormat('ru-RU')
const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0 })
export const money = (kopecks: number) => rubles.format(kopecks / 100)

export function calendarDate(day: string): Date { return new Date(`${day}T00:00:00Z`) }
export function dayKey(day: Date): string { return day.toISOString().slice(0, 10) }
export function addDays(day: Date, distance: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + distance))
}
export const dateLabel = (day: Date, options: Intl.DateTimeFormatOptions) =>
  day.toLocaleDateString('ru-RU', { ...options, timeZone: 'UTC' })
export const fullDate = (day: Date) => dateLabel(day, { day: 'numeric', month: 'long', year: 'numeric' })
export const timeLabel = (value: string, zone = 'Europe/Volgograd') =>
  new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone })

export function messageLabel(count: number): string {
  const remainder = count % 100
  if (remainder >= 11 && remainder <= 14) return 'рассылок'
  if (count % 10 === 1) return 'рассылка'
  return count % 10 >= 2 && count % 10 <= 4 ? 'рассылки' : 'рассылок'
}
