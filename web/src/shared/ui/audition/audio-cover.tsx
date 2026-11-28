import type { ReactNode } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import clara from './covers/clara.svg'
import commute from './covers/commute.svg'
import emma from './covers/emma.svg'
import gentle from './covers/gentle.svg'
import klaus from './covers/klaus.svg'
import linen from './covers/linen.svg'
import marcus from './covers/marcus.svg'
import original from './covers/original.svg'
import pulse from './covers/pulse.svg'
import velvet from './covers/velvet.svg'

// 每张插画是一个单独的 SVG 文件、用 <img> 显示：里面渐变、裁切的 id 只在自己的文件里，同一页放多少张都不会串
const COVER_ART = {
  linen,
  commute,
  pulse,
  velvet,
  emma,
  klaus,
  gentle,
  clara,
  marcus,
  original,
} as const

/** 封面插画：配乐 4 张、音色 5 张，`original` 只给「原片音色」用。 */
export type AudioCoverArt = keyof typeof COVER_ART

export type AudioCoverTraits = Partial<
  Pick<ReferenceAudio, 'audioKind' | 'gender' | 'age' | 'scenarios' | 'genre' | 'mood'>
>

type NonEmptyArts = readonly [AudioCoverArt, ...AudioCoverArt[]]

const BGM_ARTS: NonEmptyArts = ['commute', 'linen', 'pulse', 'velvet']

const VOICE_ARTS: NonEmptyArts = ['emma', 'klaus', 'gentle', 'clara', 'marcus']

// 8 类场景并成 5 张，一条音色填了几个场景时按这里的先后取第一个对得上的
const SCENARIO_ARTS: readonly (readonly [ReferenceAudio['scenarios'][number], AudioCoverArt])[] = [
  ['wellness', 'clara'],
  ['commercials', 'klaus'],
  ['trailers', 'klaus'],
  ['explainers', 'marcus'],
  ['tutorials', 'marcus'],
  ['documentaries', 'marcus'],
  ['social', 'emma'],
  ['characters', 'gentle'],
]

const pickByHash = (id: string, pool: NonEmptyArts): AudioCoverArt => {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return pool[hash % pool.length] ?? pool[0]
}

const bgmArt = (id: string, traits: AudioCoverTraits): AudioCoverArt => {
  switch (traits.genre) {
    case 'piano':
      return 'commute'
    case 'acoustic':
      return 'linen'
    case 'electronic':
      return 'pulse'
    case 'orchestral':
      return 'velvet'
    case null:
    case undefined:
      break
  }
  switch (traits.mood) {
    case 'warm':
    case 'relaxed':
      return 'linen'
    case 'uplifting':
      return 'pulse'
    case 'epic':
    case 'suspense':
      return 'velvet'
    case null:
    case undefined:
      break
  }
  return pickByHash(id, BGM_ARTS)
}

const voiceArt = (id: string, traits: AudioCoverTraits): AudioCoverArt => {
  const scenarios = traits.scenarios ?? []
  const byScenario = SCENARIO_ARTS.find(([scenario]) => scenarios.includes(scenario))
  if (byScenario !== undefined) return byScenario[1]
  const mature = traits.age === 'middle' || traits.age === 'senior'
  if (traits.gender === 'female') return mature ? 'gentle' : 'emma'
  if (traits.gender === 'male') return mature ? 'marcus' : 'klaus'
  if (traits.gender === 'neutral') return 'clara'
  return pickByHash(id, VOICE_ARTS)
}

/** 按音频子类与场景 / 声线 / 曲风 / 情绪属性挑封面插画；未填属性时按编号稳定挑一张。 */
export const audioCoverArt = (id: string, traits: AudioCoverTraits = {}): AudioCoverArt =>
  traits.audioKind === 'bgm' ? bgmArt(id, traits) : voiceArt(id, traits)

type AudioCoverProps = {
  /** 条目编号：未填属性时决定挑哪张。 */
  id: string
  title: string
  /** 音频子类与声线、场景或曲风属性；缺省按音色处理。 */
  traits?: AudioCoverTraits | undefined
  /** 直接指定插画（如「原片音色」的 `original`）；给了就不按 `id`、`traits` 挑。 */
  art?: AudioCoverArt | undefined
  /** 当前这条：在放（`playing`）或暂停着（`paused`）。 */
  state: 'idle' | 'paused' | 'playing'
  /** 不给时封面只是个样子，本身不能单独点；外层可点的元素加 `audition-cover-host` 类，悬停、聚焦时封面跟着变。 */
  onToggle?: (() => void) | undefined
  /** `md` 44px（资料库），`sm` 40px（侧栏列表），`xs` 20px（胶囊里的小头像），`2xs` 14px（时间线片段顶行里）。 */
  size?: 'md' | 'sm' | 'xs' | '2xs'
  /** 盖在封面上的东西，如等数据的提示。 */
  children?: ReactNode
}

const SIZE_CLASS = {
  md: 'is-md size-11',
  sm: 'is-sm size-10',
  xs: 'is-xs size-5',
  '2xs': 'is-xs size-3.5',
} as const

/**
 * 音频条目的插画封面，本身可作试听键：悬停、聚焦或暂停着时盖一层暗色、中间一个播放标，
 * 正在播放时暗层上换成跳动的音柱。插画自带颜色，深浅色外观下都不变。
 */
export function AudioCover({
  id,
  title,
  traits,
  art,
  state,
  onToggle,
  size = 'md',
  children,
}: AudioCoverProps) {
  const playing = state === 'playing'
  const className = cn(
    'audition-cover relative isolate grid shrink-0 place-items-center overflow-hidden',
    SIZE_CLASS[size],
    playing && 'is-playing',
    state === 'paused' && 'is-paused',
  )
  const face = (
    <>
      <img
        alt=""
        className="audition-cover-art"
        draggable={false}
        src={COVER_ART[art ?? audioCoverArt(id, traits)]}
      />
      <span aria-hidden className="audition-cover-veil">
        {playing ? (
          <span className="audition-eq">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <Icon decorative name="final-cut-play" size="sm" />
        )}
      </span>
      {children}
    </>
  )
  if (onToggle === undefined) return <span className={className}>{face}</span>
  return (
    <button
      aria-label={playing ? `暂停试听：${title}` : `试听：${title}`}
      aria-pressed={playing}
      className={cn(className, 'audition-cover-host cursor-pointer ui-focus')}
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
