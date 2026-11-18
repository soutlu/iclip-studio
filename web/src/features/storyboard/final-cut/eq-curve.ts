/** 三段均衡小图的横轴：按频率的对数从 `LOW_HZ` 铺到 `HIGH_HZ`。 */
const LOW_HZ = 50
const HIGH_HZ = 16_000
// 每一段的影响按横轴宽度的这个比例往两边散开
const SPREAD = 0.24
// 曲线隔几像素取一个点
const STEP_PX = 2

/** 小图的大小（像素）、纵向顶到边的增益（dB）和上下边各留的空（像素）。 */
type CurveBox = { width: number; height: number; rangeDb: number; inset: number }

/**
 * 三段均衡小图里的那条线（SVG path 的 `d`）：每一段在自己的频点上鼓起或凹下它的增益，往两边平滑地散开，几段叠在
 * 一起；纵向正中是 0 dB，上下边各留 `inset` 像素，`rangeDb` 顶到边。只是示意，不是滤波器真正的频响。
 */
export function eqCurvePath(
  bands: readonly { frequency: number; gain: number }[],
  { width, height, rangeDb, inset }: CurveBox,
): string {
  const span = Math.log(HIGH_HZ / LOW_HZ)
  const centers = bands.map((band) => ({
    at: Math.log(band.frequency / LOW_HZ) / span,
    gain: band.gain,
  }))
  const middle = height / 2
  const reach = middle - inset
  const points: string[] = []
  for (let x = 0; x <= width; x += STEP_PX) {
    const at = x / width
    const db = centers.reduce(
      (sum, center) => sum + center.gain * Math.exp(-(((at - center.at) / SPREAD) ** 2)),
      0,
    )
    const clamped = Math.min(rangeDb, Math.max(-rangeDb, db))
    const y = middle - (clamped / rangeDb) * reach
    points.push(`${points.length === 0 ? 'M' : 'L'}${x} ${Math.round(y * 100) / 100}`)
  }
  return points.join(' ')
}
