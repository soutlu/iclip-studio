/** 镜头的点缀色：按镜头在时间线上的位置循环取 accent-1…8，同一镜头的时间条色段与序号徽标取同一项，颜色因此总是一致。
 * 只表达镜头身份，不用于选中、状态或其它控件（见设计系统的点缀色规则）。徽标底是混入页面底色的容器色，只放在页面底上。 */

export type ShotAccent = {
  /** 时间条色段：画在 ::before 上的实色。 */
  segment: string
  /** 序号徽标：容器底色加配对字色。 */
  badge: string
}

// 类名写成完整字面量，Tailwind 才扫得到。
const SHOT_ACCENTS: readonly [ShotAccent, ...ShotAccent[]] = [
  { segment: 'before:bg-accent-1', badge: 'bg-accent-1-container text-on-accent-1-container' },
  { segment: 'before:bg-accent-2', badge: 'bg-accent-2-container text-on-accent-2-container' },
  { segment: 'before:bg-accent-3', badge: 'bg-accent-3-container text-on-accent-3-container' },
  { segment: 'before:bg-accent-4', badge: 'bg-accent-4-container text-on-accent-4-container' },
  { segment: 'before:bg-accent-5', badge: 'bg-accent-5-container text-on-accent-5-container' },
  { segment: 'before:bg-accent-6', badge: 'bg-accent-6-container text-on-accent-6-container' },
  { segment: 'before:bg-accent-7', badge: 'bg-accent-7-container text-on-accent-7-container' },
  { segment: 'before:bg-accent-8', badge: 'bg-accent-8-container text-on-accent-8-container' },
]

/** 第 `timelineIndex` 个镜头（从 0 起）的点缀色；超过 8 个从头循环。 */
export const shotAccentOf = (timelineIndex: number): ShotAccent =>
  SHOT_ACCENTS[timelineIndex % SHOT_ACCENTS.length] ?? SHOT_ACCENTS[0]
