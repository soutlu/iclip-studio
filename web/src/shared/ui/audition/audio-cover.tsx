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

const GLYPH_TONES: Record<AudioCoverGlyphName, AudioCoverTone> = {
  'audio-cover-bright': 'copper',
  'audio-cover-broadcast': 'copper',
  'audio-cover-studio': 'teal',
  'audio-cover-pulse': 'teal',
  'audio-cover-electronic': 'teal',
  'audio-cover-calm': 'umber',
  'audio-cover-acoustic': 'umber',
  'audio-cover-cinema': 'slate',
  'audio-cover-tuning': 'slate',
  'audio-cover-piano': 'slate',
  'audio-cover-dialogue': 'ochre',
  'audio-cover-vinyl': 'ochre',
}

type NonEmptyGlyphs = readonly [AudioCoverGlyphName, ...AudioCoverGlyphName[]]

const VOICE_FALLBACKS: NonEmptyGlyphs = [
  'audio-cover-bright',
  'audio-cover-studio',
  'audio-cover-calm',
  'audio-cover-pulse',
  'audio-cover-cinema',
  'audio-cover-broadcast',
  'audio-cover-dialogue',
  'audio-cover-tuning',
]

const BGM_FALLBACKS: NonEmptyGlyphs = [
  'audio-cover-piano',
  'audio-cover-acoustic',
  'audio-cover-electronic',
  'audio-cover-vinyl',
]

const pickByHash = (id: string, pool: NonEmptyGlyphs): AudioCoverGlyphName => {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return pool[hash % pool.length] ?? pool[0]
}

const bgmGlyph = (id: string, traits: AudioCoverTraits): AudioCoverGlyphName => {
  switch (traits.genre) {
    case 'piano':
      return 'audio-cover-piano'
    case 'acoustic':
      return 'audio-cover-acoustic'
    case 'electronic':
      return 'audio-cover-electronic'
    case 'orchestral':
      return 'audio-cover-vinyl'
    case null:
    case undefined:
      break
  }
  switch (traits.mood) {
    case 'warm':
    case 'relaxed':
      return 'audio-cover-acoustic'
    case 'uplifting':
      return 'audio-cover-electronic'
    case 'epic':
    case 'suspense':
      return 'audio-cover-vinyl'
    case null:
    case undefined:
      break
  }
  return pickByHash(id, BGM_FALLBACKS)
}

const voiceGlyph = (id: string, traits: AudioCoverTraits): AudioCoverGlyphName => {
  const scenarios = traits.scenarios ?? []
  if (scenarios.includes('wellness')) return 'audio-cover-calm'
  if (scenarios.includes('characters')) return 'audio-cover-dialogue'
  if (scenarios.includes('documentaries') || scenarios.includes('trailers'))
    return 'audio-cover-cinema'
  if (scenarios.includes('tutorials')) return 'audio-cover-studio'
  if (scenarios.includes('explainers')) return 'audio-cover-tuning'
  if (scenarios.includes('commercials')) {
    return traits.gender === 'female' || (traits.age === 'young' && traits.gender !== 'male')
      ? 'audio-cover-bright'
      : 'audio-cover-broadcast'
  }
  if (scenarios.includes('social')) return 'audio-cover-pulse'

  const mature = traits.age === 'middle' || traits.age === 'senior'
  if (traits.gender === 'female') return mature ? 'audio-cover-calm' : 'audio-cover-bright'
  if (traits.gender === 'male') return mature ? 'audio-cover-cinema' : 'audio-cover-pulse'
  if (traits.gender === 'neutral') return 'audio-cover-tuning'
  return pickByHash(id, VOICE_FALLBACKS)
}

/** 按音频子类与声线 / 场景 / 曲风属性匹配封面声学图标，色调跟图标走；未填属性时按编号稳定回退。 */
export const audioCoverAppearance = (
  id: string,
  traits: AudioCoverTraits = {},
): AudioCoverAppearance => {
  const glyph = traits.audioKind === 'bgm' ? bgmGlyph(id, traits) : voiceGlyph(id, traits)
  return { glyph, tone: GLYPH_TONES[glyph] }
}

type AudioCoverProps = {
  /** 条目编号：未填属性时决定回退声学图形。 */
  id: string
  title: string
  /** 音频子类与声线、场景或曲风属性；缺省按音色处理。 */
  traits?: AudioCoverTraits | undefined
  /** 当前这条：在放（`playing`）或暂停着（`paused`）。 */
  state: 'idle' | 'paused' | 'playing'
  /** 不给时封面只是个样子，本身不能单独点；外层可点的元素加 `audition-cover-host` 类，悬停、聚焦时封面跟着变。 */
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
          <span aria-hidden className="audition-cover-glyph">
            <Icon className="size-(--audition-cover-glyph-size)" decorative name={glyph} />
          </span>
          <span aria-hidden className="audition-cover-play">
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
      className={cn(className, 'audition-cover-host cursor-pointer ui-focus')}
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
      <Icon decorative name={playing ? 'final-cut-pause' : 'final-cut-play'} size="sm" />
      {children}
    </button>
  )
}
