/** 迷你趋势：一条线加淡面积，末点一个圆点；不画坐标，只看走势。 */

import { useId } from 'react'

type SparklineProps = {
  values: readonly number[]
  width: number
  height: number
}

export function Sparkline({ values, width, height }: SparklineProps) {
  const gradientId = `spark-${useId().replace(/[^\w-]/g, '')}`
  // 不到两个点连不成线，只占位。
  if (values.length < 2) {
    return <svg aria-hidden className="inline-block align-middle" height={height} width={width} />
  }
  const low = Math.min(...values)
  const high = Math.max(...values)
  const x = (index: number) => (index / (values.length - 1)) * width
  const y = (value: number) =>
    high === low ? height / 2 : height - 3 - ((value - low) / (high - low)) * (height - 6)
  const points = values.map((value, index) => `${x(index)},${y(value)}`)
  const line = `M${points.join('L')}`
  const lastValue = values.at(-1) ?? low
  return (
    <svg
      aria-hidden
      className="inline-block overflow-visible align-middle"
      height={height}
      width={width}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--color-chart-1)" stopOpacity={0.16} />
          <stop offset="1" stopColor="var(--color-chart-1)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line}L${width},${height}L0,${height}Z`} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--color-chart-1)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.75}
      />
      <circle
        cx={width}
        cy={y(lastValue)}
        fill="var(--color-chart-1)"
        r={3}
        stroke="var(--color-dashboard-card)"
        strokeWidth={1.5}
      />
    </svg>
  )
}
