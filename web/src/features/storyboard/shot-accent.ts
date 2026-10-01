/** 镜头的点缀色：按镜头在时间线上的位置循环取 accent-1…8，同一镜头的时间条色段与左轨短色签取同一项，颜色因此总是一致。
 * 只表达镜头身份，不用于选中、状态或其它控件（见设计系统的点缀色规则）；两处都是小面积实色，序号本身用中性字色。 */

export type ShotAccent = {
  /** 时间条色段：画在 ::before 上的实色。 */
  segment: string
  /** 左轨短色签的实色。 */
  tick: string
}

// 类名写成完整字面量，Tailwind 才扫得到。
const SHOT_ACCENTS: readonly [ShotAccent, ...ShotAccent[]] = [
  { segment: 'before:bg-accent-1', tick: 'bg-accent-1' },
  { segment: 'before:bg-accent-2', tick: 'bg-accent-2' },
  { segment: 'before:bg-accent-3', tick: 'bg-accent-3' },
  { segment: 'before:bg-accent-4', tick: 'bg-accent-4' },
  { segment: 'before:bg-accent-5', tick: 'bg-accent-5' },
  { segment: 'before:bg-accent-6', tick: 'bg-accent-6' },
  { segment: 'before:bg-accent-7', tick: 'bg-accent-7' },
  { segment: 'before:bg-accent-8', tick: 'bg-accent-8' },
]

/** 第 `timelineIndex` 个镜头（从 0 起）的点缀色；超过 8 个从头循环。 */
export const shotAccentOf = (timelineIndex: number): ShotAccent =>
  SHOT_ACCENTS[timelineIndex % SHOT_ACCENTS.length] ?? SHOT_ACCENTS[0]
