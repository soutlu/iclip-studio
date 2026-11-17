import {
  analyseCarveBands,
  analyseCarveDuck,
  carveBandsToChain,
  carveProfile,
  clipsOverlap,
  DEFAULT_CARVE,
  mixCarveSources,
  normalizeCarveSettings,
  type HfCarveBand,
  type HfCarveSettings,
} from '@hyperframes/core/audio-carve'
import {
  parseAudioFxChain,
  serializeAudioFxChain,
  type HfAudioFxChain,
} from '@hyperframes/core/audio-fx'
import {
  parseAutomation,
  serializeAutomation,
  type HfAutomation,
} from '@hyperframes/core/audio-automation'
import { hasSound, roleOf, VOICE_GROUP } from './audio-role'
import { isMediaClip, type FilmClip, type MediaClip } from './composition/film'
import { withoutCarveLanes } from './vendor/hyperframes-studio/components/editor/carveOutput'
import {
  clipAudioOnItsClock,
  type ClipClock,
} from './vendor/hyperframes-studio/components/editor/clipAudioClock'
import {
  carveLanes,
  mintCarveNodes,
} from './vendor/hyperframes-studio/components/editor/useFxCarveNodes'

/**
 * 自动压低：有人说话时片段自动让路，做法照参照的工作台（`useFxCarve.ts`、`useFxCarveGrouping.ts`）。设置写在
 * 被压的片段上（`data-fx-carve`：压哪些人声、强度 0–1、开没开），分析人声后生成普通的效果链（几段峰值滤波，加
 * 一段跟着人声把整体电平压下来的增益）和跟着人声走的曲线，写进 `data-fx-chain`、`data-automation`；预览和导出
 * 都按效果链放，不认设置本身。
 *
 * 压哪些人声写的是人声组（`VOICE_GROUP`），分析时按组里当时的片段算（照 core 的 `resolveCarveSourceIds`）；写设置
 * 时把重叠的、还没归组的人声一起放进人声组（照工作台选了多个人声时自动建组）。
 */
export type CarveSettings = HfCarveSettings

/** 片段上的设置；没写时是 null。写法不对的也当作没设置过（照参照的工作台）。 */
export function carveOf(clip: MediaClip): CarveSettings | null {
  if (clip.fxCarve === null) return null
  try {
    return normalizeCarveSettings(
      JSON.parse(clip.fxCarve) as Parameters<typeof normalizeCarveSettings>[0],
    )
  } catch {
    return null
  }
}

/** 能开自动压低的片段：有声音的视频、音频片段。 */
export const canCarve = (clip: FilmClip): clip is MediaClip => isMediaClip(clip) && hasSound(clip)

/**
 * 选中时会自动打开压低的片段：角色是配乐或音效（照工作台：名字像配乐、音效的才自动打开）。人声只能用户自己开，
 * 不会自动打开。
 */
export const isCarveBed = (clip: FilmClip): clip is MediaClip =>
  canCarve(clip) && roleOf(clip) !== 'voice'

/**
 * 人声：角色是人声、有声音的片段（配音片段所有语言的都算，某种语言下出不出声由人声设置定，效果链是共用的一份）。
 * 隐藏的片段不出声，不算。
 */
export const isCarveVoice = (clip: FilmClip): clip is MediaClip =>
  !clip.hidden && canCarve(clip) && roleOf(clip) === 'voice'

const spanOf = (clip: FilmClip) => ({ start: clip.start / 1000, duration: clip.duration / 1000 })

const overlapping = (bed: MediaClip) => (clip: FilmClip) =>
  clip.id !== bed.id && clipsOverlap(spanOf(bed), spanOf(clip))

/** 时间上和 `bed` 重叠的人声片段（不含它自己），按 `clips` 里的先后；`clips` 要含所有语言的配音片段。 */
export const carveVoices = (bed: MediaClip, clips: readonly FilmClip[]): MediaClip[] =>
  clips.filter((clip): clip is MediaClip => isCarveVoice(clip) && overlapping(bed)(clip))

/** 名单里的一项还在不在：片段编号是这个片段还在，组名是组里还有片段（照工作台）。 */
const resolves = (id: string, clips: readonly FilmClip[]) =>
  clips.some((clip) => clip.id === id || (isMediaClip(clip) && clip.audioGroup === id))

/** 现在重叠的人声都有时压人声组，没有时名单空着。 */
const voiceSources = (bed: MediaClip, clips: readonly FilmClip[]) =>
  carveVoices(bed, clips).length > 0 ? [VOICE_GROUP] : []

/**
 * 不用用户动手时 `bed` 的设置该改成什么，不用改时是 null。照参照的工作台：
 * - 没设置过、角色是配乐或音效、有和它重叠的人声：默认开，压人声组，强度用默认值；
 * - 开着、名单里有的已经没了（片段删了，或组里没有片段了）：去掉没了的；都没了时有重叠的人声就换成人声组，
 *   没有就空着（生成的效果链跟着去掉）；
 * - 开着、名单是空的：有重叠的人声时换成人声组。
 * 关着（`enabled: false`）的不动：用户关掉以后不再自动打开。
 */
export function nextCarve(bed: MediaClip, clips: readonly FilmClip[]): CarveSettings | null {
  const carve = carveOf(bed)
  const voices = voiceSources(bed, clips)
  if (carve === null)
    return isCarveBed(bed) && voices.length > 0 ? { ...DEFAULT_CARVE, sources: voices } : null
  if (!carve.enabled) return null
  const surviving = carve.sources.filter((id) => resolves(id, clips))
  if (surviving.length > 0)
    return surviving.length === carve.sources.length ? null : { ...carve, sources: surviving }
  if (voices.length > 0) return { ...carve, sources: voices }
  return carve.sources.length > 0 ? { ...carve, sources: [] } : null
}

/** 用户打开或关掉：打开时压人声组，强度留着之前的（没设置过用默认值）；关掉只记 `enabled: false`。 */
export function switchedCarve(
  bed: MediaClip,
  clips: readonly FilmClip[],
  on: boolean,
): CarveSettings {
  const carve = carveOf(bed) ?? DEFAULT_CARVE
  return on
    ? { ...carve, enabled: true, sources: voiceSources(bed, clips) }
    : { ...carve, enabled: false }
}

/**
 * 按设置 `settings` 写 `bed` 时：`grouped` 是要一起放进人声组的片段（名单写人声组时，和它重叠、还没归组的人声），
 * `voices` 是要量的人声——名单展开以后（组名换成组里的片段，`grouped` 算在人声组里；照 core 的
 * `resolveCarveSourceIds`）和它重叠的人声，不含它自己，按 `clips` 里的先后。关着时两个都是空的。
 */
export function carvePlan(
  bed: MediaClip,
  settings: CarveSettings,
  clips: readonly FilmClip[],
): { grouped: string[]; voices: MediaClip[] } {
  if (!settings.enabled) return { grouped: [], voices: [] }
  const candidates = carveVoices(bed, clips)
  const grouped = settings.sources.includes(VOICE_GROUP)
    ? candidates.filter((clip) => clip.audioGroup === null).map((clip) => clip.id)
    : []
  const groupOf = (clip: MediaClip) => (grouped.includes(clip.id) ? VOICE_GROUP : clip.audioGroup)
  const voices = candidates.filter((clip) =>
    settings.sources.some((id) => clip.id === id || groupOf(clip) === id),
  )
  return { grouped, voices }
}

/** 解码用的采样率：参照的工作台所有压低配乐的测量都按它（生成曲线时也按它算时间）。 */
export const CARVE_SAMPLE_RATE = 48_000

/** 读出一个素材地址的整个声音：单声道，采样率 `CARVE_SAMPLE_RATE`。 */
export type CarveDecode = (src: string) => Promise<Float32Array>

/** 量出来的结果：要压的频段、它们的滤波链、整体电平要压的曲线，和放在配乐时钟上的人声。 */
export type CarveMeasurement = {
  bands: HfCarveBand[]
  carved: HfAudioFxChain
  duck: { t: number; v: number }[]
  voiceMix: Float32Array
}

/** 片段放素材的哪一段：入点、速度、时长（秒）。 */
export const clockOf = (clip: MediaClip): ClipClock => ({
  inPoint: clip.mediaStart / 1000,
  rate: clip.playbackRate,
  duration: clip.duration / 1000,
})

/**
 * 量配乐 `bed` 怎么给人声 `voices` 让路，步骤照参照的工作台：每段人声按它的入点、速度、时长取出实际放的声音，
 * 按开始时间叠到配乐的时钟上；配乐之外的部分不要；按强度从叠好的人声里挑要压的频段，再和配乐比出每一刻整体
 * 电平要压多少。人声一点声音都没有时是 null（没有要让的）。`decode` 读不出时把错误抛出去。
 */
export async function measureCarve(
  bed: MediaClip,
  voices: readonly MediaClip[],
  strength: number,
  decode: CarveDecode,
): Promise<CarveMeasurement | null> {
  const decoded = await Promise.all(
    voices.map(async (voice) => ({
      samples: clipAudioOnItsClock(await decode(voice.src), CARVE_SAMPLE_RATE, clockOf(voice)),
      offsetSeconds: (voice.start - bed.start) / 1000,
    })),
  )
  const mixed = mixCarveSources(decoded, CARVE_SAMPLE_RATE)
  if (mixed.length === 0) return null
  const profile = carveProfile(strength)
  const bedSamples = clipAudioOnItsClock(await decode(bed.src), CARVE_SAMPLE_RATE, clockOf(bed))
  // 配乐停了以后的人声没有配乐可压
  const voiceMix = mixed.subarray(0, bedSamples.length)
  const bands = analyseCarveBands(voiceMix, CARVE_SAMPLE_RATE, profile)
  const duck = analyseCarveDuck(voiceMix, bedSamples, CARVE_SAMPLE_RATE, profile, 0)
  return { bands, carved: carveBandsToChain(bands), duck, voiceMix }
}

const EMPTY_CHAIN: HfAudioFxChain = { version: 1, nodes: [] }
const EMPTY_AUTOMATION: HfAutomation = { version: 1, lanes: [] }

// 照参照的工作台：片段上读不出的效果链、曲线当作空的，重写时用新的盖掉
/** 片段上 `data-fx-chain` 的值读成效果链；没写、读不出时是空的。 */
export const chainOf = (text: string | undefined): HfAudioFxChain => {
  if (text === undefined) return EMPTY_CHAIN
  try {
    return parseAudioFxChain(text)
  } catch {
    return EMPTY_CHAIN
  }
}

/** 片段上 `data-automation` 的值读成曲线；没写、读不出时是空的。 */
export const automationOf = (text: string | undefined): HfAutomation => {
  if (text === undefined) return EMPTY_AUTOMATION
  try {
    return parseAutomation(text)
  } catch {
    return EMPTY_AUTOMATION
  }
}

/** 效果链要写的值：一个节点都没有时是 null（去掉属性）。 */
export const chainText = (chain: HfAudioFxChain) =>
  chain.nodes.length > 0 ? serializeAudioFxChain(chain) : null

/** 曲线要写的值：一条都没有时是 null（去掉属性）。 */
export const automationText = (automation: HfAutomation) =>
  automation.lanes.length > 0 ? serializeAutomation(automation) : null

/**
 * 片段上的效果链 `chain`、曲线 `automation`（属性原来的值）换成这次的结果以后要写的值（null 是去掉这个属性）：
 * `measured` 是新量的结果时，上一次压低配乐生成的节点和曲线换成新的；是 null（关掉了、没有人声）时只去掉它们。
 * 别的节点和曲线都留着。
 */
export function carveAttributes(
  chain: string | undefined,
  automation: string | undefined,
  measured: CarveMeasurement | null,
): { chain: string | null; automation: string | null } {
  const before = chainOf(chain)
  const carried = withoutCarveLanes(automationOf(automation), before)
  if (measured === null)
    return {
      chain: chainText({ version: 1, nodes: before.nodes.filter((node) => !node.fromCarve) }),
      automation: automationText(carried),
    }
  const { next, carvedNodes, duckNode } = mintCarveNodes(before, measured.carved, measured.duck)
  const lanes = carveLanes(carvedNodes, duckNode, measured.duck, measured.voiceMix, measured.bands)
  return {
    chain: chainText(next),
    automation: automationText({ version: 1, lanes: [...carried.lanes, ...lanes] }),
  }
}
