/** 出片次数分布：1 / 2 / 3 / 4 / 5 次及以上五根柱，同一套有序色阶，柱顶标镜数。 */

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
} from 'recharts'
import { fmtRate } from '../overview-format'
import { ATTEMPT_BINS, type AttemptSummary } from '../overview-model'
import { ChartTooltipCard } from './chart-tooltip'
import { useElementSize } from './use-element-size'

const HEIGHT = 210

type Row = { name: string; shots: number; share: number; color: string }

export function AttemptBars({ summary }: { summary: AttemptSummary }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const rows: Row[] = ATTEMPT_BINS.map((bin, index) => ({
    color: bin.color,
    name: bin.name,
    share: summary.shotShares[index] ?? 0,
    shots: summary.shots[index] ?? 0,
  }))
  const barSize = Math.min(24, (size.width / rows.length) * 0.56)
  return (
    <div
      aria-label="出片次数分布"
      className="w-full"
      ref={ref}
      role="img"
      style={{ height: HEIGHT }}
    >
      {size.width > 0 ? (
        <BarChart
          accessibilityLayer={false}
          data={rows}
          height={HEIGHT}
          margin={{ bottom: 0, left: 0, right: 0, top: 22 }}
          width={size.width}
        >
          <XAxis
            axisLine={false}
            dataKey="name"
            height={24}
            interval={0}
            tick={{ fill: 'var(--color-on-surface-muted)', fontSize: 11 }}
            tickLine={false}
          />
          <YAxis domain={[0, 'dataMax']} hide />
          <ReferenceLine stroke="var(--color-chart-grid)" y={0} />
          <Bar
            barSize={barSize}
            dataKey="shots"
            isAnimationActive={false}
            shape={(props: BarShapeProps) => <CategoryBar {...props} />}
          >
            {rows.map((row) => (
              <Cell fill={row.color} key={row.name} />
            ))}
            <LabelList
              dataKey="shots"
              fill="var(--color-on-surface)"
              fontSize={12}
              fontWeight={600}
              offset={6}
              position="top"
            />
          </Bar>
          <Tooltip
            content={(props: TooltipContentProps) => <BinTooltip {...props} />}
            cursor={false}
            isAnimationActive={false}
          />
        </BarChart>
      ) : null}
    </div>
  )
}

/** 零镜的档不画柱，只留柱顶的「0」。 */
function CategoryBar({ x, y, width, height, fill }: BarShapeProps) {
  if (height <= 0) return null
  const drawn = Math.max(3, height)
  const top = y + height - drawn
  const r = Math.min(4, width / 2, drawn)
  return (
    <path
      d={`M${x},${top + drawn}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${top + drawn}Z`}
      fill={fill}
    />
  )
}

function BinTooltip({ active, payload }: TooltipContentProps) {
  const row = payload[0]?.payload as Row | undefined
  if (!active || row === undefined) return null
  return (
    <ChartTooltipCard
      rows={[
        {
          color: row.color,
          mark: 'box',
          name: `占 ${fmtRate(row.share)}`,
          value: `${row.shots} 镜`,
        },
      ]}
      title={`出片 ${row.name}的镜头`}
    />
  )
}
