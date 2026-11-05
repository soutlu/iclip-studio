const OPEN_MS = 300
const CLOSE_MS = 217
const POSE_LENGTH = 6

type Pose = readonly number[]

type MascotNode = {
  element: Element
  from: Pose
  to: Pose
}

const parsePose = (raw: string | null): Pose | null => {
  const pose = raw?.split(',').map(Number) ?? []
  return pose.length === POSE_LENGTH && pose.every(Number.isFinite) ? pose : null
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const ease = (x: number): number => {
  let low = 0
  let high = 1
  let t = x
  for (let i = 0; i < 16; i += 1) {
    const at = 3 * (1 - t) ** 2 * t * 0.3 + 3 * (1 - t) * t ** 2 * 0.7 + t ** 3
    if (at < x) low = t
    else high = t
    t = (low + high) / 2
  }
  return 3 * (1 - t) ** 2 * t * 0.15 + 3 * (1 - t) * t ** 2 * 0.85 + t ** 3
}

export class CueMascot {
  private readonly nodes: MascotNode[]
  private progress = 0
  private frame = 0

  constructor(svg: SVGSVGElement) {
    this.nodes = [...svg.querySelectorAll('[data-cue-node]')].map((element) => {
      const from = parsePose(element.getAttribute('data-from'))
      const to = parsePose(element.getAttribute('data-to'))
      if (!from || !to) throw new Error('吉祥物 SVG 的动画姿态无效')
      return { element, from, to }
    })
    if (this.nodes.length === 0) throw new Error('吉祥物 SVG 没有动画节点')
    this.render(0)
  }

  setExpanded(expanded: boolean, { animate = true } = {}): void {
    cancelAnimationFrame(this.frame)
    const target = expanded ? 1 : 0
    if (!animate || prefersReducedMotion() || this.progress === target) {
      this.render(target)
      return
    }
    const from = this.progress
    const duration = expanded ? OPEN_MS : CLOSE_MS
    const start = performance.now()
    const tick = (now: number) => {
      const time = Math.min(1, (now - start) / duration)
      this.render(from + (target - from) * ease(time))
      this.frame = time < 1 ? requestAnimationFrame(tick) : 0
    }
    this.frame = requestAnimationFrame(tick)
  }

  destroy(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private render(progress: number): void {
    this.progress = progress
    for (const { element, from, to } of this.nodes) {
      const [x, y, angle, scaleX, scaleY, opacity] = from.map(
        (start, i) => start + ((to[i] ?? start) - start) * progress,
      )
      element.setAttribute(
        'transform',
        `translate(${x} ${y}) rotate(${(angle ?? 0) * (180 / Math.PI)}) scale(${scaleX} ${scaleY})`,
      )
      element.setAttribute('opacity', String(opacity))
    }
  }
}
