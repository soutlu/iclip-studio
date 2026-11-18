import { moveIntoSyncStart, syncOffsetFrames, type SyncTiming } from '@hyperframes/core/media-link'
import { linkedWith } from './clip-edit'
import {
  isDetachedAudio,
  isMediaClip,
  type AudioClip,
  type ClipAttribute,
  type FilmClip,
  type MediaClip,
  type VideoClip,
} from './composition/film'
import { originalSoundChanges, type AttributeChanges } from './original-sound'
import { landingOn } from './placement'

/**
 * 视频片段和从它分离出来的原声（`data-sync-origin` 相同的一个视频片段、一个音频片段）。
 * 照参照的工作台：分离时两段写上同一个链接名，联动着；解除联动后出处还在，仍是一对。
 */
export type SoundPair = {
  video: VideoClip
  audio: AudioClip
  /** 两段联动着：链接名相同。 */
  linked: boolean
  /**
   * 原声比画面晚多少毫秒（早是负的），0 是口型同步：两段的「素材零点」（开始 − 入点 ÷ 速度）之差。
   * 两段速度不同时错开的量随播放变，没有一个值，是 null。
   */
  offsetMs: number | null
}

const endOf = (clip: FilmClip) => clip.start + clip.duration

const sharedMs = (left: FilmClip, right: FilmClip) =>
  Math.min(endOf(left), endOf(right)) - Math.max(left.start, right.start)

/**
 * 和 `clip` 出自同一个文件的另一种片段（视频对音频、音频对视频）。有几个时照引擎的找法：
 * 时间上和它重叠得最多的，一样多时开始离它最近的。
 */
const syncPartnerOf = (clip: MediaClip, clips: readonly FilmClip[]): MediaClip | undefined => {
  let best: { clip: MediaClip; shared: number; distance: number } | undefined
  for (const other of clips) {
    if (!isMediaClip(other) || other.kind === clip.kind || other.syncOrigin !== clip.syncOrigin)
      continue
    const shared = sharedMs(clip, other)
    const distance = Math.abs(other.start - clip.start)
    if (
      best === undefined ||
      shared > best.shared ||
      (shared === best.shared && distance < best.distance)
    )
      best = { clip: other, shared, distance }
  }
  return best?.clip
}

/** 引擎的同步算法按秒算。 */
const syncTiming = (clip: MediaClip): SyncTiming => ({
  start: clip.start / 1000,
  mediaStart: clip.mediaStart / 1000,
  playbackRate: clip.playbackRate,
})

/** `clip` 所在的一对；不是分离出来的原声、也不是分离过原声的视频片段时是 undefined。 */
export const soundPairOf = (clip: FilmClip, clips: readonly FilmClip[]): SoundPair | undefined => {
  if (!isMediaClip(clip) || clip.syncOrigin === null) return undefined
  const partner = syncPartnerOf(clip, clips)
  if (partner === undefined) return undefined
  const video = clip.kind === 'video' ? clip : partner
  const audio = clip.kind === 'audio' ? clip : partner
  if (video.kind !== 'video' || audio.kind !== 'audio') return undefined
  return {
    video,
    audio,
    linked: linkedWith(video, clips).some((other) => other.id === audio.id),
    // 按 1000 帧每秒算出来的帧数就是毫秒数
    offsetMs: syncOffsetFrames(syncTiming(audio), syncTiming(video), 1000),
  }
}

/** 错开的量写成「+0.40s」「-1.25 秒」（`unit` 是后面的单位）；不到 0.01 秒时多写一位，免得写成 0.00。 */
export const offsetText = (offsetMs: number, unit = 's'): string => {
  const size = Math.abs(offsetMs) / 1000
  return `${offsetMs < 0 ? '-' : '+'}${size.toFixed(size < 0.01 ? 3 : 2)}${unit}`
}

/** 声音属性：分离时从视频片段搬到原声上，合并时搬回来。 */
const SOUND_ATTRIBUTES = [
  'data-volume',
  'data-fade-in',
  'data-fade-out',
] as const satisfies readonly ClipAttribute[]

/** 这个视频片段为什么不能分离音频；能分离时是 undefined。`silent` 是素材确认没有声音。 */
export const detachBlocked = (clip: VideoClip, silent: boolean): string | undefined => {
  if (silent) return '该素材没有声音，无法分离音频'
  return clip.muted ? '已关闭原声，无法分离音频；请先打开原声' : undefined
}

/**
 * 分离音频时视频片段要改的属性：照参照的工作台关掉原声，声音属性去掉（搬到原声上），写上链接名和出处，
 * 两个都是 `name`。
 */
export const detachedVideoChanges = (name: string): AttributeChanges => ({
  ...originalSoundChanges(true),
  ...Object.fromEntries(SOUND_ATTRIBUTES.map((attribute) => [attribute, null])),
  'data-link': name,
  'data-sync-origin': name,
})

/** 这一对为什么不能合并回视频；能合并时是 undefined。 */
export const mergeBlocked = ({ video, audio, offsetMs }: SoundPair): string | undefined => {
  if (offsetMs === null) return '原声和画面的倍速不同，无法合并；请先调成相同的倍速'
  if (offsetMs !== 0) return '原声和画面没对齐，请先对齐口型'
  if (video.hidden !== audio.hidden)
    return audio.hidden
      ? '原声已静音、画面未隐藏，无法合并；请先取消原声的静音'
      : '画面已隐藏、原声未静音，无法合并；请先显示画面'
  return video.muted ? undefined : '画面已打开原声，无法合并；请先关闭画面的原声'
}

/**
 * 合并回视频时视频片段要改的属性：原声上的声音属性（`audioAttributes` 是原声元素上的属性）写回来，
 * 打开原声，去掉链接名和出处。
 */
export const mergedVideoChanges = (
  audioAttributes: Readonly<Record<string, string>>,
): AttributeChanges => ({
  ...Object.fromEntries(
    SOUND_ATTRIBUTES.map((attribute) => [attribute, audioAttributes[attribute] ?? null]),
  ),
  ...originalSoundChanges(false),
  'data-link': null,
  'data-sync-origin': null,
})

export const DETACH_LABEL = '分离音频'
export const MERGE_LABEL = '合并回视频'

/**
 * 「分离音频」钮（工具条、⇧⌘B、「属性」头部、右键菜单）对选中的片段做什么：视频片段是分离，已分离的一对
 * 里的任何一个是合并回视频；`blocked` 是做不了的原因。
 */
export type SoundAction =
  | { kind: 'detach'; video: VideoClip; blocked: string | undefined }
  | { kind: 'merge'; pair: SoundPair; blocked: string | undefined }
  | { kind: 'none'; blocked: string }

/** `targets`（选中的片段，或点右键的那一个）上的「分离音频」钮；`silent` 说素材确认没有声音。 */
export const soundActionFor = (
  targets: readonly FilmClip[],
  clips: readonly FilmClip[],
  silent: (src: string) => boolean,
): SoundAction => {
  const [target] = targets
  if (target === undefined)
    return { kind: 'none', blocked: '尚未选中片段，无法分离音频；请先选中一个视频片段' }
  if (targets.length > 1)
    return { kind: 'none', blocked: '选中了多个片段，无法分离音频；请只选中一个片段' }
  const pair = soundPairOf(target, clips)
  if (pair !== undefined) return { kind: 'merge', pair, blocked: mergeBlocked(pair) }
  if (target.kind === 'video')
    return { kind: 'detach', video: target, blocked: detachBlocked(target, silent(target.src)) }
  return { kind: 'none', blocked: '只有视频片段可以分离音频' }
}

/** 时间线上分离出来的原声右边的小标：静音、错开（提示色）、联动，都不是时没有。 */
export type SoundBadge = { text: string; tone: 'muted' | 'offset' | 'linked' }

export const soundBadgeOf = (
  clip: FilmClip,
  clips: readonly FilmClip[],
): SoundBadge | undefined => {
  if (!isDetachedAudio(clip)) return undefined
  if (clip.hidden) return { text: '静音', tone: 'muted' }
  const pair = soundPairOf(clip, clips)
  if (pair === undefined) return undefined
  if (pair.offsetMs === null) return { text: '倍速不同', tone: 'offset' }
  if (pair.offsetMs !== 0) return { text: `错开 ${offsetText(pair.offsetMs)}`, tone: 'offset' }
  return pair.linked ? { text: '联动', tone: 'linked' } : undefined
}

/** 「属性」和右键菜单里对一对做的事，由编辑器接到会话上。 */
export type SoundControls = {
  /** 分离或合并（`SoundAction` 不是 `none`、没被拦下时才调）。 */
  run: (action: SoundAction) => void
  /** 打开或关掉联动。 */
  link: (pair: SoundPair, linked: boolean) => void
  /** 对齐口型（按 `resyncPlan`）。 */
  resync: (pair: SoundPair) => void
  /** 选中这个片段并滚到看得见的地方。 */
  locate: (id: string) => void
}

/** 对齐口型：原声挪到的起点（毫秒），`displaced` 是落点被占着、放到了最近的空位；对不了时是原因。 */
export type ResyncPlan = { start: number; displaced: boolean } | { refusal: string }

/**
 * 对齐口型只挪原声的开始，挪到它的素材零点和画面的重合（引擎的「挪回同步」）；原声那一行在那里被占着时
 * 放到最近的空位。两段倍速不同、或者要挪到 0 秒之前时对不了。
 */
export const resyncPlan = (pair: SoundPair, clips: readonly FilmClip[]): ResyncPlan => {
  const { video, audio } = pair
  if (pair.offsetMs === null) return { refusal: '原声和画面的倍速不同，无法对齐口型' }
  const synced = moveIntoSyncStart(syncTiming(audio), syncTiming(video))
  if (synced === null) return { refusal: '对齐后原声会早于 0 秒，无法对齐口型' }
  const wanted = Math.round(synced * 1000)
  const { start } = landingOn(
    clips.filter((clip) => clip.id !== audio.id),
    { zone: 'audio', track: audio.track },
    wanted,
    audio.duration,
  )
  return { start, displaced: start !== wanted }
}
