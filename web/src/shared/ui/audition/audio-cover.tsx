import type { ReactNode } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import type { AudioCoverGlyphName } from '@/shared/icons/audio-cover-glyphs'
import { cn } from '@/shared/lib/utils'

export type AudioCoverTone = 'copper' | 'teal' | 'umber' | 'slate' | 'ochre'

export type AudioCoverAppearance = {
  readonly glyph: AudioCoverGlyphName
  readonly tone: AudioCoverTone
}

export type AudioCoverTraits = Partial<
  Pick<ReferenceAudio, 'audioKind' | 'gender' | 'age' | 'scenarios' | 'genre' | 'mood'>
>

type NonEmptyAppearances = readonly [AudioCoverAppearance, ...AudioCoverAppearance[]]

const VOICE_FALLBACKS: NonEmptyAppearances = [
  { glyph: 'audio-cover-bright', tone: 'copper' },
  { glyph: 'audio-cover-studio', tone: 'teal' },
  { glyph: 'audio-cover-calm', tone: 'umber' },
  { glyph: 'audio-cover-pulse', tone: 'teal' },
  { glyph: 'audio-cover-cinema', tone: 'slate' },
  { glyph: 'audio-cover-broadcast', tone: 'copper' },
  { glyph: 'audio-cover-dialogue', tone: 'ochre' },
  { glyph: 'audio-cover-tuning', tone: 'slate' },
]

const BGM_FALLBACKS: NonEmptyAppearances = [
  { glyph: 'audio-cover-piano', tone: 'slate' },
  { glyph: 'audio-cover-acoustic', tone: 'umber' },
  { glyph: 'audio-cover-electronic', tone: 'teal' },
  { glyph: 'audio-cover-vinyl', tone: 'ochre' },
]

const pickByHash = (id: string, pool: NonEmptyAppearances): AudioCoverAppearance => {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return pool[hash % pool.length] ?? pool[0]
}

const bgmAppearance = (id: string, traits: AudioCoverTraits): AudioCoverAppearance => {
  switch (traits.genre) {
    case 'piano':
      return { glyph: 'audio-cover-piano', tone: 'slate' }
    case 'acoustic':
      return { glyph: 'audio-cover-acoustic', tone: 'umber' }
    case 'electronic':
      return { glyph: 'audio-cover-electronic', tone: 'teal' }
    case 'orchestral':
      return { glyph: 'audio-cover-vinyl', tone: 'ochre' }
    case null:
    case undefined:
      break
  }
  switch (traits.mood) {
    case 'warm':
    case 'relaxed':
      return { glyph: 'audio-cover-acoustic', tone: 'umber' }
    case 'uplifting':
      return { glyph: 'audio-cover-electronic', tone: 'teal' }
    case 'epic':
    case 'suspense':
      return { glyph: 'audio-cover-vinyl', tone: 'ochre' }
    case null:
    case undefined:
      break
  }
  return pickByHash(id, BGM_FALLBACKS)
}

const voiceAppearance = (id: string, traits: AudioCoverTraits): AudioCoverAppearance => {
  const scenarios = traits.scenarios ?? []
  if (scenarios.includes('wellness')) return { glyph: 'audio-cover-calm', tone: 'umber' }
  if (scenarios.includes('characters')) return { glyph: 'audio-cover-dialogue', tone: 'ochre' }
  if (scenarios.includes('documentaries') || scenarios.includes('trailers'))
    return { glyph: 'audio-cover-cinema', tone: 'slate' }
  if (scenarios.includes('tutorials')) return { glyph: 'audio-cover-studio', tone: 'teal' }
  if (scenarios.includes('explainers')) return { glyph: 'audio-cover-tuning', tone: 'slate' }
  if (scenarios.includes('commercials')) {
    return traits.gender === 'female' || (traits.age === 'young' && traits.gender !== 'male')
      ? { glyph: 'audio-cover-bright', tone: 'copper' }
      : { glyph: 'audio-cover-broadcast', tone: 'copper' }
  }
  if (scenarios.includes('social')) return { glyph: 'audio-cover-pulse', tone: 'teal' }

  const mature = traits.age === 'middle' || traits.age === 'senior'
  if (traits.gender === 'female') {
    return mature
      ? { glyph: 'audio-cover-calm', tone: 'umber' }
      : { glyph: 'audio-cover-bright', tone: 'copper' }
  }
  if (traits.gender === 'male') {
    return mature
      ? { glyph: 'audio-cover-cinema', tone: 'slate' }
      : { glyph: 'audio-cover-pulse', tone: 'teal' }
  }
  if (traits.gender === 'neutral') return { glyph: 'audio-cover-tuning', tone: 'slate' }
  return pickByHash(id, VOICE_FALLBACKS)
}

/** 按音频子类与声线 / 场景 / 曲风属性匹配封面声学图标与主形色调；未填属性时按编号稳定回退。 */
export const audioCoverAppearance = (
  id: string,
  traits: AudioCoverTraits = {},
): AudioCoverAppearance =>
  traits.audioKind === 'bgm' ? bgmAppearance(id, traits) : voiceAppearance(id, traits)

type AudioCoverProps = {
  /** 条目编号：未填属性时决定回退声学图形。 */
  id: string
  title: string
  /** 音频子类与声线、场景或曲风属性；缺省按音色处理。 */
  traits?: AudioCoverTraits | undefined
  /** 当前这条：在放（`playing`）或暂停着（`paused`）。 */
  state: 'idle' | 'paused' | 'playing'
  /** 不给时封面只是个样子（外层整张卡片可带 `group/cover` 联动悬停），本身不能单独点。 */
  onToggle?: (() => void) | undefined
  /** `md` 44px（资料库），`sm` 36px（窄的侧栏）。 */
  size?: 'md' | 'sm'
  /** 盖在封面上的东西，如等数据的提示。 */
  children?: ReactNode
}

/**
 * 音频条目的声学封面，本身可作试听键：纯中性底块配双层声学图标；
 * 悬停、聚焦或暂停态平滑切换为纯墨播放标，正在播放时切换为反色底与跳动音柱。
 */
export function AudioCover({
  id,
  title,
  traits,
  state,
  onToggle,
  size = 'md',
  children,
}: AudioCoverProps) {
  const playing = state === 'playing'
  const paused = state === 'paused'
  const { glyph, tone } = audioCoverAppearance(id, traits)
  const className = cn(
    'audition-cover relative isolate grid shrink-0 place-items-center',
    size === 'md' ? 'is-md size-11' : 'size-9',
    playing && 'is-playing bg-inverse-surface text-inverse-on-surface',
    paused && 'is-paused',
  )
  const face = (
    <>
      {playing ? (
        <span aria-hidden className="audition-eq">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <>
          <span
            aria-hidden
            className={cn(
              'grid place-items-center transition-[opacity,transform] ui-motion-s group-hover/cover:scale-90 group-hover/cover:opacity-0 group-focus-visible/cover:scale-90 group-focus-visible/cover:opacity-0',
              paused && 'scale-90 opacity-0',
            )}
          >
            {size === 'md' ? (
              <Icon className="size-7" decorative name={glyph} />
            ) : (
              <Icon decorative name={glyph} size="xl" />
            )}
          </span>
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 grid scale-90 place-items-center text-on-surface opacity-0 transition-[opacity,transform] ui-motion-s group-hover/cover:scale-100 group-hover/cover:opacity-100 group-focus-visible/cover:scale-100 group-focus-visible/cover:opacity-100',
              paused && 'scale-100 opacity-100',
            )}
          >
            <Icon decorative name="final-cut-play" size="sm" />
          </span>
        </>
      )}
      {children}
    </>
  )
  if (onToggle === undefined)
    return (
      <span className={className} data-tone={tone}>
        {face}
      </span>
    )
  return (
    <button
      aria-label={playing ? `暂停试听：${title}` : `试听：${title}`}
      aria-pressed={playing}
      className={cn(className, 'group/cover cursor-pointer ui-focus')}
      data-tone={tone}
      onClick={onToggle}
      type="button"
    >
      {face}
    </button>
  )
}

type AuditionButtonProps = {
  label: string
  playing: boolean
  onToggle: () => void
  /** 深色底（试听条上的主键）；不给时浅灰底，放着时才变深色。 */
  ink?: boolean
  className?: string | undefined
  children?: ReactNode
}

/** 圆形的播放 / 暂停键：没有封面的条目（音效）和试听条用它。 */
export function AuditionButton({
  label,
  playing,
  onToggle,
  ink = false,
  className,
  children,
}: AuditionButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={playing}
      className={cn(
        'relative grid size-9 shrink-0 ui-state cursor-pointer place-items-center rounded-full ui-focus',
        ink || playing
          ? 'bg-inverse-surface text-inverse-on-surface'
          : 'bg-surface-container text-on-surface',
        className,
      )}
      onClick={onToggle}
      type="button"
    >
      <Icon decorative name={playing ? 'pause' : 'play'} size="sm" />
      {children}
    </button>
  )
}
