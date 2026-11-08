export type ShotAccent = {
  segment: string
  tick: string
}

// 使用完整类名字符串以供 Tailwind 静态扫描识别。
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

export const shotAccentOf = (timelineIndex: number): ShotAccent =>
  SHOT_ACCENTS[timelineIndex % SHOT_ACCENTS.length] ?? SHOT_ACCENTS[0]
