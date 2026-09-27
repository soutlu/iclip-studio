/** 总览的时间序列图：柱、折线、堆叠面积、堆叠柱四种，叠 7 日实线与 30 日灰虚线、非活跃日灰底与悬停提示。

Recharts 画坐标、柱、线与面积；灰底、悬停带、当天的点与超出纵轴的小三角是读坐标系的自绘层。 */

import { useId } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  ZIndexLayer,
  useActiveTooltipLabel,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  type BarShapeProps,
  type TooltipContentProps,
} from 'recharts'
import { cn } from '@/shared/lib/utils'
import { tickEvery } from '../overview-format'
import type { ChartModel, ChartPoint } from '../overview-model'
import { ChartTooltipCard } from './chart-tooltip'
import { useElementSize } from './use-element-size'

const MARGIN = { top: 10, right: 8, bottom: 0, left: 0 }
const Y_AXIS_WIDTH = 46
const TICK = { fill: 'var(--color-on-surface-muted)', fontSize: 11 }
const CARD = 'var(--color-dashboard-card)'

/** 自绘层在 Recharts 分层里的位置：灰底与悬停带在网格（-100）之下，点与三角在线之上。 */
const Z = { inactive: -150, hover: -120, marks: 600, crosshair: 1100 } as const

type OverviewChartProps = {
  model: ChartModel
  /** 读屏用的图名。 */
  label: string
  /** 给了就用固定高度；不给就撑满父容器（卡片里的图）。 */
  height?: number
  className?: string
}

export function OverviewChart({ model, label, height, className }: OverviewChartProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const gradientId = `overview-area-${useId().replace(/[^\w-]/g, '')}`
  const chartHeight = height ?? size.height
  const count = Math.max(model.points.length, 1)
  const band = (size.width - Y_AXIS_WIDTH - MARGIN.right) / count
  const barSize = Math.max(2, Math.min(24, band - 2, band * 0.64))
  const every = tickEvery(band, model.bucket)
  const ticks = model.points.filter((_, index) => index % every === 0).map((point) => point.key)
  const tickText = new Map(model.points.map((point) => [point.key, point.tick]))
  const yMin = model.yTicks[0] ?? 0
  const yMax = model.yTicks.at(-1) ?? 1
  const mainKey = model.hasLine ? 'line' : 'value'

  return (
    <div
      aria-label={`${label}趋势`}
      className={cn('relative w-full min-w-0', height === undefined && 'min-h-35', className)}
      ref={ref}
      role="img"
      style={height === undefined ? undefined : { height }}
    >
      {size.width > 0 && chartHeight > 0 ? (
        <ComposedChart
          accessibilityLayer={false}
          barGap={0}
          data={model.points}
          height={chartHeight}
          margin={MARGIN}
          width={size.width}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--color-chart-1)" stopOpacity={0.16} />
              <stop offset="1" stopColor="var(--color-chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <InactiveBands points={model.points} />
          <HoverLayer model={model} />
          <CartesianGrid stroke="var(--color-chart-grid)" vertical={false} />
          {/* 折线也按格排：点落在每格正中，灰底与悬停带才有宽度。 */}
          <XAxis
            axisLine={false}
            dataKey="key"
            height={24}
            interval={0}
            scale="band"
            tick={TICK}
            tickFormatter={(key: string) => tickText.get(key) ?? ''}
            tickLine={false}
            ticks={ticks}
          />
          <YAxis
            allowDataOverflow
            axisLine={false}
            domain={[yMin, yMax]}
            interval={0}
            tick={TICK}
            tickFormatter={(value: number) => model.axis(value)}
            tickLine={false}
            ticks={model.yTicks}
            type="number"
            width={Y_AXIS_WIDTH}
          />
          {model.baseline === null ? null : (
            <ReferenceLine
              label={<BaselineLabel text={model.baseline.label} />}
              stroke="var(--color-on-surface-muted)"
              strokeOpacity={0.5}
              y={model.baseline.value}
            />
          )}

          {model.kind === 'line' && model.area ? (
            <Area
              activeDot={false}
              baseValue={yMin}
              dataKey={mainKey}
              fill={`url(#${gradientId})`}
              fillOpacity={1}
              isAnimationActive={false}
              stroke="none"
              type="linear"
            />
          ) : null}
          {model.kind === 'line' ? (
            <Line
              activeDot={false}
              dataKey={mainKey}
              dot={false}
              isAnimationActive={false}
              stroke="var(--color-chart-1)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              type="linear"
            />
          ) : null}

          {model.kind === 'stack'
            ? model.partColors.map((color, part) => (
                <Area
                  activeDot={false}
                  dataKey={(point: ChartPoint) => point.parts?.[part] ?? null}
                  fill={color}
                  fillOpacity={1}
                  isAnimationActive={false}
                  key={color}
                  stackId="parts"
                  // 层与层之间用卡片色细线隔开；最上一层不描边。
                  stroke={part < model.partColors.length - 1 ? CARD : 'none'}
                  strokeWidth={1.5}
                  type="linear"
                />
              ))
            : null}

          {model.kind === 'bar' ? (
            <Bar
              barSize={barSize}
              dataKey={(point: ChartPoint) => point.value ?? 0}
              isAnimationActive={false}
              shape={(props: BarShapeProps) => <BarMark {...props} />}
            />
          ) : null}
          {model.kind === 'stackbar'
            ? model.partColors.map((color, part) => (
                <Bar
                  barSize={barSize}
                  dataKey={(point: ChartPoint) => point.parts?.[part] ?? 0}
                  isAnimationActive={false}
                  key={color}
                  shape={(props: BarShapeProps) => (
                    <StackSegment {...props} color={color} layer={part} />
                  )}
                  stackId="parts"
                />
              ))
            : null}

          {/* 柱图与堆叠柱上叠的 7 日均线用主色，和柱子分得开。 */}
          {(model.kind === 'bar' || model.kind === 'stackbar') && model.hasLine ? (
            <Line
              activeDot={false}
              dataKey="line"
              dot={false}
              isAnimationActive={false}
              stroke="var(--color-primary)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              type="linear"
            />
          ) : null}
          {model.hasSlow ? (
            <Line
              activeDot={false}
              dataKey="slow"
              dot={false}
              isAnimationActive={false}
              stroke="var(--color-chart-ghost)"
              strokeDasharray="4 4"
              strokeLinecap="round"
              strokeWidth={2}
              type="linear"
            />
          ) : null}

          <DayMarks model={model} yMax={yMax} />
          <Tooltip
            content={(props: TooltipContentProps) => <PointTooltip {...props} />}
            cursor={false}
            isAnimationActive={false}
            offset={16}
          />
        </ComposedChart>
      ) : null}
    </div>
  )
}

/** 基准线的说明写在线的右端上方。viewBox 由 Recharts 克隆标签时传入。 */
function BaselineLabel({
  text,
  viewBox,
}: {
  text: string
  viewBox?: { x: number; y: number; width: number }
}) {
  if (viewBox === undefined) return null
  return (
    <text
      fill="var(--color-on-surface-muted)"
      fontSize={11}
      textAnchor="end"
      x={viewBox.x + viewBox.width}
      y={viewBox.y - 6}
    >
      {text}
    </text>
  )
}

/** 一格在横轴上的起止与中点。 */
const useBand = () => {
  const scale = useXAxisScale()
  return (key: string) => {
    const start = scale?.(key, { position: 'start' })
    const end = scale?.(key, { position: 'end' })
    const middle = scale?.(key, { position: 'middle' })
    return start === undefined || end === undefined || middle === undefined
      ? null
      : { end, middle, start }
  }
}

/** 非活跃日铺浅灰底，读的人一眼知道那天的 0 是没人用，不是出了事。 */
function InactiveBands({ points }: { points: readonly ChartPoint[] }) {
  const bandOf = useBand()
  const plot = usePlotArea()
  if (plot === undefined) return null
  return (
    <ZIndexLayer zIndex={Z.inactive}>
      {points.map((point) => {
        const band = point.inactive ? bandOf(point.key) : null
        return band === null ? null : (
          <rect
            fill="var(--color-chart-inactive)"
            height={plot.height}
            key={point.key}
            width={band.end - band.start}
            x={band.start}
            y={plot.y}
          />
        )
      })}
    </ZIndexLayer>
  )
}

/** 悬停的那一格铺一条浅带；折线类再加一根竖线和主线上的点。 */
function HoverLayer({ model }: { model: ChartModel }) {
  const active = useActiveTooltipLabel()
  const bandOf = useBand()
  const yScale = useYAxisScale()
  const plot = usePlotArea()
  const point = model.points.find((item) => item.key === active)
  const band = point === undefined ? null : bandOf(point.key)
  if (point === undefined || band === null || plot === undefined) return null
  const crosshair = model.kind === 'line' || model.kind === 'stack'
  const main = model.kind === 'line' ? (model.hasLine ? point.line : point.value) : null
  const mainY = main === null ? undefined : yScale?.(main)
  return (
    <>
      <ZIndexLayer zIndex={Z.hover}>
        <rect
          fill="var(--color-state-hover)"
          height={plot.height}
          rx={6}
          width={band.end - band.start}
          x={band.start}
          y={plot.y}
        />
      </ZIndexLayer>
      {crosshair ? (
        <ZIndexLayer zIndex={Z.crosshair}>
          <line
            stroke="var(--color-on-surface-muted)"
            strokeOpacity={0.35}
            x1={band.middle}
            x2={band.middle}
            y1={plot.y}
            y2={plot.y + plot.height}
          />
          {mainY === undefined ? null : (
            <circle
              cx={band.middle}
              cy={mainY}
              fill="var(--color-chart-1)"
              r={4.5}
              stroke={CARD}
              strokeWidth={2}
            />
          )}
        </ZIndexLayer>
      ) : null}
    </>
  )
}

/**
 * 有均线时当天的值画成点（折线用比线深一档的绿，堆叠面积用中性深灰），超出纵轴的画成图顶朝上的小三角；
 * 按周没有均线，折线本身就是原始值，四十五格以内在每格上点一个圆点。
 */
function DayMarks({ model, yMax }: { model: ChartModel; yMax: number }) {
  const bandOf = useBand()
  const yScale = useYAxisScale()
  const plot = usePlotArea()
  if (yScale === undefined || plot === undefined) return null
  const weekly = model.kind === 'line' && !model.hasLine && model.points.length <= 45
  if (!model.dayMarks && !weekly) return null
  const color =
    model.kind === 'stack' ? 'var(--color-on-surface-variant)' : 'var(--color-chart-ord-4)'
  return (
    <ZIndexLayer zIndex={Z.marks}>
      {model.points.map((point) => {
        const band = point.value === null ? null : bandOf(point.key)
        if (band === null || point.value === null) return null
        if (weekly) {
          const cy = yScale(point.value)
          return cy === undefined ? null : (
            <circle
              cx={band.middle}
              cy={cy}
              fill="var(--color-chart-1)"
              key={point.key}
              r={3.5}
              stroke={CARD}
              strokeWidth={2}
            />
          )
        }
        if (point.value > yMax) {
          const x = band.middle
          const top = plot.y
          return (
            <path
              d={`M${x - 4},${top + 6}L${x},${top}L${x + 4},${top + 6}Z`}
              fill={color}
              key={point.key}
            />
          )
        }
        const cy = yScale(point.value)
        return cy === undefined ? null : (
          <circle cx={band.middle} cy={cy} fill={color} key={point.key} r={3} />
        )
      })}
    </ZIndexLayer>
  )
}

/** 顶边两角圆、底边直角的柱形路径。 */
const roundedTop = (x: number, y: number, width: number, height: number, radius: number) => {
  const r = Math.min(radius, width / 2, height)
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

/** 零值画一截贴底的短横，免得读成没数据。 */
function Nub({ x, width, base }: { x: number; width: number; base: number }) {
  return <rect fill="var(--color-hairline)" height={2} rx={1} width={width} x={x} y={base - 2} />
}

/** 悬停时其余格的柱子压淡，突出当前这一格。 */
const useDimmed = (key: string) => {
  const active = useActiveTooltipLabel()
  return active !== undefined && active !== key
}

function BarMark({ x, y, width, height, payload }: BarShapeProps) {
  const point = payload as ChartPoint
  const dimmed = useDimmed(point.key)
  const base = y + height
  if (point.value === null || point.value === 0 || height <= 0) {
    return <Nub base={base} width={width} x={x} />
  }
  const drawn = Math.max(3, height)
  return (
    <path
      d={roundedTop(x, base - drawn, width, drawn, 4)}
      fill="var(--color-chart-1)"
      fillOpacity={point.inactive ? 0.5 : 1}
      opacity={dimmed ? 0.45 : 1}
    />
  )
}

/** 堆叠柱的一段：段与段之间留 2px 缝，只有最上面一段圆角；整格为零时只由第一段画一截短横。 */
function StackSegment({
  x,
  y,
  width,
  height,
  payload,
  color,
  layer,
}: BarShapeProps & { color: string; layer: number }) {
  const point = payload as ChartPoint
  const dimmed = useDimmed(point.key)
  const parts = point.parts ?? []
  const value = parts[layer] ?? 0
  const positive = (item: number | null) => (item ?? 0) > 0
  if (!parts.some(positive))
    return layer === 0 ? <Nub base={y + height} width={width} x={x} /> : null
  if (value <= 0) return null
  const below = parts.slice(0, layer).some(positive)
  const above = parts.slice(layer + 1).some(positive)
  const drawn = Math.max(1, below ? height - 2 : height)
  const common = {
    fill: color,
    fillOpacity: point.inactive ? 0.5 : 1,
    opacity: dimmed ? 0.45 : 1,
  }
  return above ? (
    <rect {...common} height={drawn} width={width} x={x} y={y} />
  ) : (
    <path {...common} d={roundedTop(x, y, width, drawn, 4)} />
  )
}

function PointTooltip({ active, payload }: TooltipContentProps) {
  const point = payload[0]?.payload as ChartPoint | undefined
  if (!active || point === undefined) return null
  return <ChartTooltipCard rows={point.rows} />
}
