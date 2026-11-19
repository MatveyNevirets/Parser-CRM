import { useEffect, useId, useRef, useState } from 'react'
import {
  addDays, calendarDate, dateLabel, dayKey, fullDate, messageLabel, money, number, periods,
  type Activity, type Period, type Totals,
} from '../lib/analytics'

const reportedTeamTotal = 56

export function ReportedTeamTotal() {
  return <section className="analytics-panel" aria-label="Указанный общий итог рассылок">
    <h3>Рассылки команды за всё время</h3>
    <strong className="analytics-money">{number.format(reportedTeamTotal)}</strong>
    <p className="analytics-meta">Указано вручную</p>
  </section>
}

export function PeriodTotals({ totals, format = (value) => number.format(value), totalLabel = 'За всё время' }: {
  totals: Totals; format?: (value: number) => string; totalLabel?: string
}) {
  return <dl className="period-totals">
    {[...periods.map(({ key, totalLabel: label }) => ({ key, label })), { key: 'total', label: totalLabel } as const].map(({ key, label }) =>
      <div key={key}><dt>{label}</dt><dd>{format(totals[key])}</dd></div>)}
  </dl>
}

interface Point { key: string; label: string; description: string; value: number }

function timeline(activity: Activity, period: Period, financial: boolean): Point[] {
  const today = calendarDate(activity.today)
  const daily = financial ? activity.earnings?.daily ?? {} : activity.daily
  const day = (date: Date) => ({ key: dayKey(date), label: period === 'week'
    ? dateLabel(date, { weekday: 'short' }) : String(date.getUTCDate()), description: fullDate(date), value: daily[dayKey(date)] ?? 0 })
  if (period === 'day') {
    if (financial) return [day(today)]
    return Array.from({ length: 24 }, (_, hour) => ({
      key: String(hour), label: String(hour).padStart(2, '0'), description: `${String(hour).padStart(2, '0')}:00`, value: activity.hourly[hour] ?? 0,
    }))
  }
  if (period === 'week') {
    const start = calendarDate(activity.week_start)
    return Array.from({ length: 7 }, (_, index) => day(addDays(start, index)))
  }
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()
  if (period === 'month') {
    const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return Array.from({ length }, (_, index) => day(new Date(Date.UTC(year, month, index + 1))))
  }
  const monthly = new Map<string, number>()
  for (const [date, value] of Object.entries(daily)) {
    const key = date.slice(0, 7)
    monthly.set(key, (monthly.get(key) ?? 0) + value)
  }
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, index, 1))
    const key = dayKey(date).slice(0, 7)
    return { key, label: dateLabel(date, { month: 'short' }), description: dateLabel(date, { month: 'long', year: 'numeric' }), value: monthly.get(key) ?? 0 }
  })
}

export function ActivityChart({ activity, financial = false }: { activity: Activity; financial?: boolean }) {
  const titleId = useId()
  const [period, setPeriod] = useState<Period>('week')
  const [selected, setSelected] = useState<string | null>(null)
  const points = timeline(activity, period, financial)
  const maximum = Math.max(1, ...points.map((point) => point.value))
  const format = financial ? money : (value: number) => `${number.format(value)} ${messageLabel(value)}`
  const point = points.find((item) => item.key === selected)
  const plottedTotal = points.reduce((sum, item) => sum + item.value, 0)
  const dailyCorrection = !financial && period === 'day' ? activity.counts.day - plottedTotal : 0
  return <section className="analytics-panel" aria-labelledby={titleId}>
    <header className="analytics-heading">
      <h3 id={titleId}>{financial ? 'Динамика начислений' : 'Динамика рассылок'}</h3>
      <div className="analytics-tabs" role="group" aria-label={financial ? 'Период начислений' : 'Период рассылок'}>
        {periods.map(({ key, label }) => <button key={key} aria-pressed={period === key}
          onClick={() => { setPeriod(key); setSelected(null) }}>{label}</button>)}
      </div>
    </header>
    <p className="analytics-selection" aria-live="polite">{point ? `${point.description} — ${format(point.value)}`
      : format(plottedTotal + dailyCorrection)}</p>
    {dailyCorrection !== 0 && <p className="analytics-meta">Корректировка за день {dailyCorrection > 0 ? '+' : ''}{number.format(dailyCorrection)} без привязки ко времени.</p>}
    <div className="chart-scroll">
      <div className="activity-bars" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`,
        minWidth: points.length * 23 }}>
        {points.map(({ key, label, description, value }) => <button key={key} type="button"
          title={`${description} — ${format(value)}`} aria-label={`${description} — ${format(value)}`} aria-pressed={key === selected}
          onClick={() => setSelected(key)} onFocus={() => setSelected(key)} onPointerEnter={() => setSelected(key)}>
          <span className="chart-bar-area" aria-hidden><i style={{ height: `${value / maximum * 100}%` }} data-empty={value === 0} /></span>
          <span className="chart-tick" aria-hidden>{label}</span>
        </button>)}
      </div>
    </div>
  </section>
}

export function ActivityCalendar({ activity }: { activity: Activity }) {
  const titleId = useId()
  const grid = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const today = calendarDate(activity.today)
  const start = addDays(today, -364)
  const offset = (start.getUTCDay() + 6) % 7
  const dates = Array.from({ length: 365 }, (_, index) => addDays(start, index))
  const weeks = Math.ceil((dates.length + offset) / 7)
  const values = dates.map((date) => activity.daily[dayKey(date)] ?? 0)
  const max = Math.max(1, ...values)
  const months = new Map<number, string>()
  dates.forEach((date, index) => {
    if (index === 0 || date.getUTCDate() === 1) months.set(Math.floor((index + offset) / 7) + 2, dateLabel(date, { month: 'short' }))
  })
  const focusedValue = focused === null ? null : values[focused]
  const total = values.reduce((sum, value) => sum + value, 0)
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth
  }, [])

  return <section className="analytics-panel" aria-labelledby={titleId}>
    <header className="analytics-heading"><h3 id={titleId}>Календарь активности</h3>
      <span className="analytics-meta">{number.format(total)} {messageLabel(total)} за 365 дней</span></header>
    <div className="chart-scroll" ref={scroll}>
      <div ref={grid} className="activity-calendar" role="group" aria-label="365 дней активности"
        style={{ gridTemplateColumns: `24px repeat(${weeks}, minmax(10px, 1fr))` }}>
        {[...months].map(([col, label]) => <span className="calendar-month" key={col} style={{ gridColumn: col, gridRow: 1 }}>{label}</span>)}
        {[[0, 'Пн'], [2, 'Ср'], [4, 'Пт']].map(([index, label]) => <span className="calendar-weekday" key={label}
          style={{ gridColumn: 1, gridRow: Number(index) + 2 }}>{label}</span>)}
        {dates.map((date, index) => {
          const position = index + offset
          const value = values[index]
          const label = `${fullDate(date)} — ${number.format(value)} ${messageLabel(value)}`
          return <button className="calendar-day" key={dayKey(date)} type="button" data-index={index}
            data-level={value ? Math.ceil(value * 4 / max) : 0} aria-pressed={focused === index}
            title={label} aria-label={label} tabIndex={index === (focused ?? 364) ? 0 : -1}
            style={{ gridColumn: Math.floor(position / 7) + 2, gridRow: position % 7 + 2 }}
            onFocus={() => setFocused(index)} onClick={() => setFocused(index)} onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') setFocused(index)
            }} onKeyDown={(event) => {
              const moves: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
              const distance = moves[event.key]
              if (!distance) return
              event.preventDefault()
              const target = Math.max(0, Math.min(364, index + distance))
              grid.current?.querySelector<HTMLButtonElement>(`[data-index="${target}"]`)?.focus()
            }} />
        })}
      </div>
    </div>
    <div className="calendar-footer">
      <span className="analytics-selection" aria-live="polite">{focused !== null && focusedValue !== null
        ? `${fullDate(dates[focused])} — ${number.format(focusedValue)} ${messageLabel(focusedValue)}`
        : `${fullDate(start)} — ${fullDate(today)}`}</span>
      <span className="calendar-legend" aria-label="Интенсивность активности">Меньше
        {[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} aria-hidden />)} Больше</span>
    </div>
  </section>
}
