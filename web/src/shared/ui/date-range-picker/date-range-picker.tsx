import { useEffect, useRef, useState } from 'react'
import {
  DATE_RANGE_DAY_PRESETS,
  dateRangeLabel,
  dateRangePresetDays,
  formatLocalDate,
  isDateRangeDayPreset,
  parseLocalDate,
  UNBOUNDED_RANGE,
  type DateRange,
} from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { RangeCalendar } from './range-calendar'

type DateRangePickerProps = {
  value: DateRange
  /** 只交回可应用的范围；自定义只选一端时保持在组件内。 */
  onChange: (value: DateRange) => void
}

const CLEARED_RANGE = UNBOUNDED_RANGE

/** 与 Tailwind 的 sm 断点一致：宽屏并排两个月。 */
const WIDE_SCREEN = '(min-width: 40rem)'

const dateName = (date: Date): string =>
  `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`

const startOfDay = (date: Date): Date => {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/** 宽屏并排两个月；shared 里还没有通用的媒体查询 hook，这里只读这一条。 */
function useWideScreen(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_SCREEN).matches)

  useEffect(() => {
    const query = window.matchMedia(WIDE_SCREEN)
    const sync = () => setWide(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return wide
}

/** 时间浮层内容：快捷范围即选即用并在日历上高亮，点日期开始自定义草稿，选满两端后再应用。 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [today] = useState(() => startOfDay(new Date()))
  const [editingCustom, setEditingCustom] = useState(false)
  const [draftStart, setDraftStart] = useState<Date | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const wideScreen = useWideScreen()
  const appliedStart =
    value.range === 'custom' && value.since !== null ? parseLocalDate(value.since) : null
  const appliedEnd =
    value.range === 'custom' && value.until !== null ? parseLocalDate(value.until) : null
  const isCustom = editingCustom || draftStart !== null || value.range === 'custom'
  const activeRange = isCustom ? 'custom' : value.range
  const start = draftStart ?? appliedStart
  const end = draftStart === null ? appliedEnd : null
  const fullRange = start !== null && end !== null ? { from: start, to: end } : undefined
  const presetDays = dateRangePresetDays(value.range)

  // 日历常驻，可聚焦的那一天始终在 DOM 里，从 chip 切进自定义时直接把焦点交给它。
  const focusCalendar = () => {
    rootRef.current?.querySelector<HTMLButtonElement>('td button[tabindex="0"]')?.focus()
  }

  const selectRange = (range: string) => {
    if (range === 'custom') {
      setEditingCustom(true)
      focusCalendar()
      return
    }
    setDraftStart(null)
    setEditingCustom(false)
    if (isDateRangeDayPreset(range)) {
      onChange(value.range === range ? CLEARED_RANGE : { range, since: null, until: null })
      return
    }
    // 空值来自再次点击当前 chip：草稿只丢草稿，已生效的范围才清除筛选。
    if (range === '' && !(isCustom && value.range !== 'custom')) {
      onChange(CLEARED_RANGE)
    }
  }

  const selectDay = (date: Date) => {
    if (draftStart === null) {
      setDraftStart(date)
      return
    }
    const [since, until] = date < draftStart ? [date, draftStart] : [draftStart, date]
    setDraftStart(null)
    onChange({ range: 'custom', since: formatLocalDate(since), until: formatLocalDate(until) })
  }

  const rangeDescription =
    start === null
      ? '选择开始日期'
      : end === null
        ? `${start.getMonth() + 1}月${start.getDate()}日 — 选择结束日期`
        : dateRangeLabel({
            range: 'custom',
            since: formatLocalDate(start),
            until: formatLocalDate(end),
          })

  return (
    <div className="p-4" ref={rootRef}>
      <ChipGroup
        aria-label="时间范围"
        className="flex-nowrap gap-1 rounded-full bg-surface-container-low p-1"
        onValueChange={selectRange}
        type="single"
        value={activeRange}
      >
        {[...DATE_RANGE_DAY_PRESETS, 'custom' as const].map((range) => (
          <FilterChip
            className="min-w-0 flex-1 justify-center border-0 bg-transparent px-1 text-body font-normal data-[state=on]:bg-top-layer data-[state=on]:shadow-[var(--shadow-1)]"
            key={range}
            value={range}
          >
            {range === 'custom' ? '自定义' : dateRangeLabel({ range, since: null, until: null })}
          </FilterChip>
        ))}
      </ChipGroup>

      <div className="mt-4">
        <RangeCalendar
          defaultMonth={start ?? today}
          footer={rangeDescription}
          labelDay={dateName}
          modifiers={{
            endpoint: [start, end].filter((date): date is Date => date !== null),
            inRange: fullRange,
            // 高亮含今天在内的 N 个整日；实际筛选从此刻往前数 N×24 小时（见 dateRangeBounds），差一个部分日。
            preset:
              presetDays === null ? undefined : { from: addDays(today, 1 - presetDays), to: today },
            rangeEnd: fullRange?.to,
            rangeStart: fullRange?.from,
            // 只有「选中」进 aria-selected，预设高亮不占这个语义。
            selected: fullRange ?? start ?? undefined,
          }}
          numberOfMonths={wideScreen ? 2 : 1}
          onDayClick={selectDay}
          today={today}
        />
      </div>
    </div>
  )
}
