/** 审计页工具条：左边快捷档与常显实际区间的日期按钮（点开是预设加双月日历），右边由各页签放自己的东西。 */

import { useEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import {
  DayPicker,
  type ChevronProps,
  type ClassNames,
  type DayButtonProps,
  type DayProps,
  type Formatters,
  type Labels,
} from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, iconButtonVariants } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import {
  fromCalendarDay,
  startOfZonedDay,
  startOfZonedMonth,
  toCalendarDay,
  zonedParts,
} from '../audit-time'
import { monthDay } from '../overview-format'
import {
  customRange,
  OVERVIEW_PRESETS,
  overviewDays,
  overviewRangeLabel,
  PRESET_LABELS,
  QUICK_PRESETS,
  type OverviewPreset,
  type OverviewRange,
} from '../overview-range'

type OverviewToolbarProps = {
  range: OverviewRange
  onChange: (next: OverviewRange) => void
  /** 右侧：总览写环比对比的日期，清单放按人筛选。 */
  children?: ReactNode
}

/** 浮在页面灰底上的控件外壳：卡片色底、卡片描边（浅色下透明）加极淡的影。 */
const RAISED = 'border border-dashboard-card-edge bg-dashboard-card shadow-[var(--shadow-xs)]'

/** 工具条上带图标的按钮（日期、按人筛选）；选中时加粗。可作弹层的 asChild 触发器。 */
export function PickButton({
  selected,
  className,
  ...props
}: ComponentPropsWithRef<'button'> & { selected: boolean }) {
  return (
    <button
      className={cn(
        'inline-flex h-8.5 ui-state cursor-pointer items-center gap-1.5 rounded-md px-3 text-body whitespace-nowrap text-on-surface-variant ui-focus hover:text-on-surface',
        RAISED,
        selected && 'font-semibold text-on-surface',
        className,
      )}
      type="button"
      {...props}
    />
  )
}

export function OverviewToolbar({ range, onChange, children }: OverviewToolbarProps) {
  const [now] = useState(() => new Date())
  const quick = QUICK_PRESETS.some((item) => item.preset === range.preset)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChipGroup
          aria-label="时间范围"
          className={cn('flex-nowrap gap-0.5 rounded-md p-0.75', RAISED)}
          onValueChange={(value) => {
            const preset = QUICK_PRESETS.find((item) => item.preset === value)?.preset
            if (preset !== undefined) onChange({ preset })
          }}
          type="single"
          value={quick ? range.preset : ''}
        >
          {QUICK_PRESETS.map((item) => (
            <FilterChip
              className="h-7 rounded-sm border-0 bg-transparent px-3 text-body font-normal text-on-surface-muted hover:text-on-surface data-[state=on]:bg-state-active data-[state=on]:font-semibold data-[state=on]:text-on-surface"
              key={item.preset}
              value={item.preset}
            >
              {item.label}
            </FilterChip>
          ))}
        </ChipGroup>
        <RangePopover now={now} onApply={onChange} range={range} selected={!quick} />
      </div>
      {children}
    </div>
  )
}

/** 日期按钮始终写出实际区间；选的不是快捷档时它就是当前选中项。 */
function RangePopover({
  range,
  now,
  onApply,
  selected,
}: {
  range: OverviewRange
  now: Date
  onApply: (next: OverviewRange) => void
  selected: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = overviewRangeLabel(range, now)
  return (
    <PopupRoot onOpenChange={setOpen} open={open}>
      <PopupTrigger asChild>
        <PickButton
          aria-haspopup="dialog"
          aria-label={`自定义时间范围：${label}`}
          selected={selected}
          title="自定义时间范围"
        >
          <Icon decorative name="calendar" size="md" />
          {label}
        </PickButton>
      </PopupTrigger>
      <PopupSurface
        align="start"
        aria-label="选择时间范围"
        className="max-w-[calc(100vw-32px)] overflow-hidden rounded-lg"
        collisionPadding={16}
        role="dialog"
        sideOffset={8}
      >
        <RangePicker
          initial={range}
          now={now}
          onApply={(next) => {
            setOpen(false)
            onApply(next)
          }}
          onCancel={() => setOpen(false)}
        />
      </PopupSurface>
    </PopupRoot>
  )
}

const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime()
const DAY_MS = 86_400_000

/** 宽屏并排两个月、预设在左；窄屏一个月、预设在上。 */
const WIDE = '(min-width: 840px)'

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const sync = () => setWide(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return wide
}

/**
 * 左侧预设与右侧日历联动：点起点再点终点，选预设直接填好两端；应用后才生效。
 * 日历的格子、今天与可选范围都按 UTC+8 的日期；状态里每一天都是那天的 UTC+8 零点，
 * 只在交给日历与接回日历时经 toCalendarDay / fromCalendarDay 换成它认的本地日期。
 */
function RangePicker({
  initial,
  now,
  onApply,
  onCancel,
}: {
  initial: OverviewRange
  now: Date
  onApply: (next: OverviewRange) => void
  onCancel: () => void
}) {
  const wide = useWide()
  const today = startOfZonedDay(now)
  const start = overviewDays(initial, now)
  const [first, setFirst] = useState(start.first)
  const [last, setLast] = useState<Date | null>(start.last)
  const [hover, setHover] = useState<Date | null>(null)
  const [preset, setPreset] = useState<OverviewPreset | null>(
    initial.preset === 'custom' ? null : initial.preset,
  )
  // 最后一天所在的月放在右边。
  const monthFor = (day: Date) => startOfZonedMonth(day, wide ? -1 : 0)
  const [month, setMonth] = useState(() => monthFor(start.last))

  const low = last === null && hover !== null && hover < first ? hover : first
  const high = last ?? (hover !== null && hover > first ? hover : first)

  const pickPreset = (key: OverviewPreset) => {
    const days = overviewDays({ preset: key }, now)
    setFirst(days.first)
    setLast(days.last)
    setHover(null)
    setPreset(key)
    setMonth(monthFor(days.last))
  }

  const pickDay = (day: Date) => {
    setPreset(null)
    setHover(null)
    if (last !== null) {
      setFirst(day)
      setLast(null)
    } else if (day < first) {
      setLast(first)
      setFirst(day)
    } else {
      setLast(day)
    }
  }

  const apply = () => {
    if (last === null) return
    onApply(preset === null ? customRange(first, last) : { preset })
  }

  const days = Math.round((high.getTime() - low.getTime()) / DAY_MS) + 1
  const calendar = {
    high: toCalendarDay(high),
    low: toCalendarDay(low),
    today: toCalendarDay(today),
  }

  return (
    <div className="flex flex-col md:flex-row">
      <div
        aria-label="预设"
        className="flex flex-wrap gap-0.5 border-b border-hairline p-2 md:w-32 md:flex-col md:flex-nowrap md:border-r md:border-b-0 md:px-2 md:py-2.5"
        role="group"
      >
        {OVERVIEW_PRESETS.map((key) => (
          <button
            aria-pressed={preset === key}
            className={cn(
              'flex h-8.5 ui-state cursor-pointer items-center justify-between gap-2 rounded-sm px-2.5 text-left text-body text-on-surface-variant ui-focus hover:text-on-surface',
              preset === key && 'font-semibold text-on-surface',
            )}
            key={key}
            onClick={() => pickPreset(key)}
            type="button"
          >
            {PRESET_LABELS[key]}
            {preset === key ? <Icon decorative name="check" size="md" /> : null}
          </button>
        ))}
      </div>
      <div className="px-4 pt-3 pb-3.5">
        <DayPicker
          classNames={CALENDAR_CLASS_NAMES}
          components={CALENDAR_COMPONENTS}
          disabled={{ after: calendar.today }}
          endMonth={toCalendarDay(startOfZonedMonth(today))}
          formatters={CALENDAR_FORMATTERS}
          labels={CALENDAR_LABELS}
          locale={zhCN}
          modifiers={{
            endpoint: [calendar.low, calendar.high],
            inRange: { from: calendar.low, to: calendar.high },
            rangeEnd: calendar.high,
            rangeStart: calendar.low,
          }}
          modifiersClassNames={MODIFIER_CLASS_NAMES}
          month={toCalendarDay(month)}
          numberOfMonths={wide ? 2 : 1}
          onDayClick={(day) => pickDay(fromCalendarDay(day))}
          onDayMouseEnter={(day) => {
            if (last === null) setHover(fromCalendarDay(day))
          }}
          onMonthChange={(next) => setMonth(fromCalendarDay(next))}
          showOutsideDays={false}
          today={calendar.today}
          weekStartsOn={1}
        />
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-3 text-body text-on-surface-variant">
          <span role="status">
            {last === null ? (
              <>
                已选开始 <b className="text-on-surface">{monthDay(first)}</b>，再点结束日
              </>
            ) : (
              <>
                <b className="text-on-surface">
                  {sameDay(low, high) ? monthDay(low) : `${monthDay(low)} – ${monthDay(high)}`}
                </b>{' '}
                · {days} 天
              </>
            )}
          </span>
          <div className="flex gap-2">
            <Button onClick={onCancel} size="md" variant="tonal">
              取消
            </Button>
            <Button disabled={last === null} onClick={apply} size="md">
              应用
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

const DAY_CELL = 'h-8.5 p-0 text-center'

const CALENDAR_CLASS_NAMES: Partial<ClassNames> = {
  button_next: iconButtonVariants({ size: 'sm' }),
  button_previous: iconButtonVariants({ size: 'sm' }),
  caption_label: 'text-body font-medium',
  day: DAY_CELL,
  month: 'w-63',
  month_caption: 'mb-1 flex h-8 items-center justify-center',
  month_grid: 'w-full table-fixed border-collapse',
  months: 'relative flex gap-6',
  nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
  weekday: 'h-7 text-center text-caption font-normal text-on-surface-muted',
}

/** 区间底色落在格子上，两端的实心圆在按钮上。 */
const MODIFIER_CLASS_NAMES = {
  inRange: 'bg-state-active',
  rangeEnd: 'rounded-r-full',
  rangeStart: 'rounded-l-full',
}

/** 日历传进来的都是它认的本地日期，先换回 UTC+8 零点再写。 */
const CALENDAR_FORMATTERS: Partial<Formatters> = {
  formatCaption: (month) => {
    const parts = zonedParts(fromCalendarDay(month))
    return `${parts.year}年${parts.month}月`
  },
  formatWeekdayName: (weekday) => WEEKDAY_NAMES[zonedParts(fromCalendarDay(weekday)).weekday] ?? '',
}

const CALENDAR_LABELS: Partial<Labels> = {
  labelDayButton: (date) => monthDay(fromCalendarDay(date)),
  labelNext: () => '下个月',
  labelPrevious: () => '上个月',
}

/** 月首月末补位的空格子不铺区间底色。 */
function CalendarDay({ day: _day, modifiers, className, ...props }: DayProps) {
  const filler = modifiers['hidden'] === true || modifiers['outside'] === true
  return <td {...props} className={filler ? DAY_CELL : className} />
}

/** 日期按钮：两端实心主色圆，今天在数字下点一个小圆点，今天之后的日子不可选。 */
function CalendarDayButton({
  day: _day,
  modifiers,
  className: _className,
  ...props
}: DayButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const endpoint = modifiers['endpoint'] === true
  const focused = modifiers['focused'] === true
  useEffect(() => {
    if (focused) ref.current?.focus()
  }, [focused])
  return (
    <button
      {...props}
      aria-current={modifiers['today'] === true ? 'date' : undefined}
      className={cn(
        'relative mx-auto grid size-8 ui-state cursor-pointer place-items-center rounded-full text-body tabular-nums ui-focus disabled:cursor-default disabled:opacity-35',
        endpoint ? 'bg-primary font-semibold text-on-primary' : 'text-on-surface',
        modifiers['today'] === true &&
          'after:absolute after:bottom-0.75 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-current',
      )}
      ref={ref}
    />
  )
}

const CALENDAR_COMPONENTS = {
  Chevron: ({ orientation }: ChevronProps) => (
    <Icon decorative name={orientation === 'left' ? 'back' : 'next'} size="md" />
  ),
  Day: CalendarDay,
  DayButton: CalendarDayButton,
}
