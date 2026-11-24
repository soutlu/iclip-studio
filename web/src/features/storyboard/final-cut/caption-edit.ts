import type { SubtitleSentence } from '@/shared/api/generated/types.gen'
import type { Cut } from './clip-edit'
import {
  isDetachedAudio,
  isDubClip,
  MIN_CLIP_MS,
  type CaptionClip,
  type FilmClip,
  type VideoClip,
} from './composition/film'

/** 新加的一句字幕有多长（毫秒）。 */
export const CAPTION_MS = 2000

/** 新加的一句字幕先写的字。 */
export const NEW_CAPTION_TEXT = '新字幕'

export const CAPTION_REFUSAL_TEXT = {
  taken: '播放头处已有字幕，无法再加一句；请把播放头移到没有字幕的地方',
  tight: '播放头离下一句字幕不到 0.1 秒，无法加一句；请把播放头往前移',
} as const

/**
 * 在播放头 `playheadMs` 处加一句字幕时放在哪：从播放头起长 2 秒，碰到后面的字幕时缩短到碰到为止。
 * 播放头处已经有字幕、或者缩短后不到 0.1 秒时不能加，答复原因。
 */
export function captionSpot(
  captions: readonly Pick<CaptionClip, 'start' | 'duration'>[],
  playheadMs: number,
): { start: number; duration: number } | { refusal: keyof typeof CAPTION_REFUSAL_TEXT } {
  const start = Math.max(0, Math.round(playheadMs))
  if (
    captions.some((caption) => caption.start <= start && start < caption.start + caption.duration)
  )
    return { refusal: 'taken' }
  const next = Math.min(
    Infinity,
    ...captions.filter((caption) => caption.start > start).map((caption) => caption.start),
  )
  const duration = Math.min(CAPTION_MS, next - start)
  return duration < MIN_CLIP_MS ? { refusal: 'tight' } : { start, duration }
}

/**
 * 旁白（长 `durationMs` 毫秒）和它的那句字幕放在哪：从播放头 `playheadMs` 起，和已有的字幕重叠时往后挪到第一个
 * 放得下的地方。
 */
export function narrationSpot(
  captions: readonly Pick<CaptionClip, 'id' | 'start' | 'duration'>[],
  playheadMs: number,
  durationMs: number,
): { start: number; duration: number } {
  let start = Math.max(0, Math.round(playheadMs))
  for (const caption of captionsInOrder(captions))
    if (caption.start < start + durationMs && start < caption.start + caption.duration)
      start = caption.start + caption.duration
  return { start, duration: durationMs }
}

/** 字幕列表里写的时间：分:秒，秒带两位小数（`00:01.50`）。 */
export const captionClock = (ms: number): string => {
  const hundredths = Math.round(Math.max(0, ms) / 10)
  const minutes = Math.floor(hundredths / 6000)
  const seconds = ((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

/** 字幕按开始时间排，一样时按编号。 */
export const captionsInOrder = <T extends Pick<CaptionClip, 'id' | 'start'>>(
  captions: readonly T[],
): T[] =>
  captions.toSorted((left, right) => left.start - right.start || left.id.localeCompare(right.id))

type Span = { start: number; duration: number }

const endOf = (span: Span) => span.start + span.duration

const overlaps = (left: Span, right: Span) => left.start < endOf(right) && right.start < endOf(left)

const isCaption = (clip: FilmClip): clip is CaptionClip => clip.kind === 'caption'

/** 「字幕」页签里的两段：「字幕」和「组件文字」。 */
export type CaptionsView = 'captions' | 'texts'

/**
 * 选中的片段在「字幕」里对应什么：`lines` 是列表里要标成当前的字幕（选中的字幕，和选中的配音片段配的那句，
 * 旁白也算）；`view` 是该切到哪一段：选中了字幕或配音片段时是「字幕」，不然选中了有文字字段的贴片、场景（编号在
 * `textHosts` 里）时是「组件文字」，都没有时是 undefined、不切。
 */
export function captionsFocus(
  selected: readonly FilmClip[],
  textHosts: ReadonlySet<string>,
): { lines: ReadonlySet<string>; view: CaptionsView | undefined } {
  const lines = new Set(
    selected.flatMap((clip) =>
      isCaption(clip) ? [clip.id] : isDubClip(clip) ? [clip.dub.caption] : [],
    ),
  )
  const view =
    lines.size > 0
      ? 'captions'
      : selected.some((clip) => textHosts.has(clip.id))
        ? 'texts'
        : undefined
  return { lines, view }
}

/** 字幕跟着挪做不到的原因：会和别的字幕重叠；跟着配音片段挪会早于 0 秒。 */
export type CaptionFollowRefusal = 'overlap' | 'early'

export const CAPTION_FOLLOW_REFUSAL_TEXT: Readonly<Record<CaptionFollowRefusal, string>> = {
  overlap: '字幕跟着挪动后会和别的字幕重叠，无法完成这次编辑；请先挪开或删掉挡住的字幕',
  early: '字幕跟着配音片段挪动后会早于 0 秒，无法完成这次编辑；请把配音片段往后挪',
}

/** 一步编辑里字幕要怎么跟着走：挪到的新起点（编号 → 毫秒）、要删掉的字幕；做不到时是原因。 */
export type CaptionFollow =
  | { starts: ReadonlyMap<string, number>; removed: readonly string[] }
  | { refusal: CaptionFollowRefusal }

/** 改了开始、没改入点：是挪动（怎么挪的都算），不是裁开头。答复挪了多少，不是挪动时是 undefined。 */
const shiftOf = (
  was: { start: number; mediaStart: number },
  now: { start: number; mediaStart: number },
) =>
  now.start !== was.start && now.mediaStart === was.mediaStart ? now.start - was.start : undefined

/**
 * 对比一步编辑前后的片段（`before`、`after`，都含字幕和配音片段），字幕跟着挪：
 * - 配音片段挪了：它配的那句字幕挪同样的时间差，挪到 0 秒以前时整步不做；
 * - 属于视频片段的字幕（`owner`）：视频片段挪了，它的字幕挪同样的时间差，早于 0 的收在 0；
 * - 这一步里自己也改了开始的字幕（比如和它一起选中拖动）按它自己的；
 * - 视频片段没了：它的字幕删掉；
 * - 裁剪、改入点、改速度、切开：字幕不动（切开后的归属见 `splitOwners`）。
 * 挪完会和别的字幕重叠时整步都不做，答复原因。
 */
export function captionsFollowing(
  before: readonly FilmClip[],
  after: readonly FilmClip[],
): CaptionFollow {
  const now = new Map(after.map((clip) => [clip.id, clip]))
  const was = new Map(before.map((clip) => [clip.id, clip]))
  const shifts = new Map<string, number>()
  const dubShifts = new Map<string, number>()
  const gone = new Set<string>()
  for (const clip of before) {
    const next = now.get(clip.id)
    if (clip.kind === 'video') {
      if (next?.kind !== 'video') gone.add(clip.id)
      else {
        const shift = shiftOf(clip, next)
        if (shift !== undefined) shifts.set(clip.id, shift)
      }
    } else if (isDubClip(clip) && next?.kind === 'audio') {
      const shift = shiftOf(clip, next)
      if (shift !== undefined && !dubShifts.has(clip.dub.caption))
        dubShifts.set(clip.dub.caption, shift)
    }
  }
  const captions = after.filter(isCaption)
  const removed = captions
    .filter((caption) => caption.owner !== null && gone.has(caption.owner))
    .map((caption) => caption.id)
  const dropped = new Set(removed)
  const starts = new Map<string, number>()
  for (const caption of captions) {
    if (dropped.has(caption.id) || was.get(caption.id)?.start !== caption.start) continue
    const byDub = dubShifts.get(caption.id)
    if (byDub !== undefined) {
      if (caption.start + byDub < 0) return { refusal: 'early' }
      starts.set(caption.id, caption.start + byDub)
      continue
    }
    const shift = caption.owner === null ? undefined : shifts.get(caption.owner)
    if (shift !== undefined) starts.set(caption.id, Math.max(0, caption.start + shift))
  }
  const final = captions
    .filter((caption) => !dropped.has(caption.id))
    .map((caption) => ({
      id: caption.id,
      start: starts.get(caption.id) ?? caption.start,
      duration: caption.duration,
    }))
  const clash = final.some(
    (moved) =>
      starts.has(moved.id) &&
      final.some((other) => other.id !== moved.id && overlaps(moved, other)),
  )
  return clash ? { refusal: 'overlap' } : { starts, removed }
}

/**
 * 对比一步编辑前后的片段（`before`、`after`，都含字幕和所有语言的配音片段），配音片段跟着它配的那句字幕走：
 * 字幕改了开始（跟着视频片段或配音片段挪，或者自己被挪），它的各语言配音挪同样的时间差，早于 0 的收在 0；
 * 这一步里自己也改了开始的配音片段（比如被挪动、带着字幕挪的那一个）按它自己的。字幕删掉了，它的配音一起删。
 * 答复挪到的新起点和要删的配音片段。
 */
export function dubsFollowing(
  before: readonly FilmClip[],
  after: readonly FilmClip[],
): { starts: ReadonlyMap<string, number>; removed: readonly string[] } {
  const was = new Map(before.map((clip) => [clip.id, clip]))
  const now = new Map(after.map((clip) => [clip.id, clip]))
  const starts = new Map<string, number>()
  const removed: string[] = []
  for (const clip of after) {
    if (!isDubClip(clip)) continue
    const old = was.get(clip.dub.caption)
    if (old?.kind !== 'caption') continue
    const current = now.get(clip.dub.caption)
    if (current === undefined) removed.push(clip.id)
    else if (current.start !== old.start && was.get(clip.id)?.start === clip.start)
      starts.set(clip.id, Math.max(0, clip.start + current.start - old.start))
  }
  return { starts, removed }
}

/**
 * 切开视频片段以后字幕的新归属（字幕编号 → 后半段的编号）：属于被切的片段、从切点（后半段的开始）
 * 或更晚开始的字幕归后半段，跨着切点的留在前半段。`halves` 是被切的片段 → 它的后半段。
 */
export function splitOwners(
  clips: readonly FilmClip[],
  cuts: readonly Cut[],
  halves: ReadonlyMap<string, string>,
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const cut of cuts) {
    const half = halves.get(cut.id)
    if (half === undefined) continue
    for (const clip of clips)
      if (isCaption(clip) && clip.owner === cut.id && clip.start >= cut.second.start)
        owners.set(clip.id, half)
  }
  return owners
}

/** 要识别字幕的一个视频片段，和它的素材对上的生成记录。 */
export type RecognitionTarget = { clipId: string; sourceJobId: string }

/** 为什么一个可识别的视频片段都没有：没有视频片段、都已有字幕、剩下的都没有声音或对不上素材。 */
export type RecognitionRefusal = 'empty' | 'captioned' | 'unusable'

export const RECOGNITION_REFUSAL_TEXT: Readonly<Record<RecognitionRefusal, string>> = {
  empty: 'final-cut 里暂无视频片段，无法识别字幕；请先加入镜头',
  captioned: '视频片段都已有字幕，无法再识别；删掉一个片段的全部字幕后可重新识别',
  unusable: '视频片段都关闭了原声或找不到素材记录，无法识别字幕；请先打开原声',
}

/** 视频片段有没有声音可识别：没关闭原声，或者它的原声分离出来了。 */
const audible = (video: VideoClip, clips: readonly FilmClip[]) =>
  !video.muted ||
  (video.syncOrigin !== null &&
    clips.some((clip) => isDetachedAudio(clip) && clip.syncOrigin === video.syncOrigin))

/**
 * 「识别字幕」要识别哪些视频片段：有声音、还没有属于它的字幕、素材地址能对上一条生成记录（`jobOf`）的。
 * 已有字幕的不再识别，免得盖掉手改过的字。一个都没有时答复原因。
 */
export function recognitionTargets(
  clips: readonly FilmClip[],
  jobOf: (src: string) => string | undefined,
): { targets: readonly RecognitionTarget[] } | { refusal: RecognitionRefusal } {
  const videos = clips.filter((clip): clip is VideoClip => clip.kind === 'video')
  if (videos.length === 0) return { refusal: 'empty' }
  const owners = new Set(clips.filter(isCaption).map((caption) => caption.owner))
  const bare = videos.filter((video) => !owners.has(video.id))
  if (bare.length === 0) return { refusal: 'captioned' }
  const targets = bare.flatMap((video) => {
    const sourceJobId = audible(video, clips) ? jobOf(video.src) : undefined
    return sourceJobId === undefined ? [] : [{ clipId: video.id, sourceJobId }]
  })
  return targets.length === 0 ? { refusal: 'unusable' } : { targets }
}

/** 识别出来的一句：在素材里的起止（毫秒）和字。 */
export type Sentence = Pick<SubtitleSentence, 'startMs' | 'endMs' | 'text'>

/** 待加入轨道的单句字幕：起止时间（毫秒）、文本及归属的视频片段 ID（手动添加时为 `null`）。 */
export type NewCaption = Span & { text: string; owner: string | null }

/** 视频片段用掉的那段素材（从入点起、长 时长 × 速度）里有没有素材时间 `ms`。 */
const playsAt = (video: VideoClip, ms: number) =>
  video.mediaStart <= ms && ms < video.mediaStart + video.duration * video.playbackRate

/** 视频片段用掉的那段素材和句子在素材里的起止有没有重叠。 */
const playsPart = (video: VideoClip, sentence: Sentence) =>
  video.mediaStart < sentence.endMs &&
  sentence.startMs < video.mediaStart + video.duration * video.playbackRate

/**
 * 视频片段 `video` 名下要加的字幕，一句一条、字是整句：一句话只由播出它开头的片段写（句子开头在片段用掉的那段
 * 素材里），这样一句话跨过两个相接的片段时只在前一个片段名下写一条整句；开头哪个有声的片段都没播出（被裁掉了）
 * 时，由时间线上第一个播出这句一部分的有声片段写。`clips` 是 final-cut 里的全部片段，用来找同一条素材的有声片段。
 * 时间是 `片段开始 + (句子时间 − 入点) ÷ 速度`：开头被裁掉的截到片段开头，结尾不截，照句子的结尾，所以跨过接缝的
 * 一句占到它说完为止。不到最短长度的、字是空的不要。
 */
export function sentenceCaptions(
  video: VideoClip,
  sentences: readonly Sentence[],
  clips: readonly FilmClip[],
): NewCaption[] {
  const heard = clips
    .filter(
      (clip): clip is VideoClip =>
        clip.kind === 'video' && clip.src === video.src && audible(clip, clips),
    )
    .toSorted((left, right) => left.start - right.start)
  const at = (ms: number) => video.start + (ms - video.mediaStart) / video.playbackRate
  return sentences.flatMap((sentence) => {
    const writes =
      playsAt(video, sentence.startMs) ||
      (!heard.some((clip) => playsAt(clip, sentence.startMs)) &&
        heard.find((clip) => playsPart(clip, sentence))?.id === video.id)
    const text = sentence.text.trim()
    const start = Math.round(Math.max(video.start, at(sentence.startMs)))
    const end = Math.round(at(sentence.endMs))
    return !writes || text === '' || end - start < MIN_CLIP_MS
      ? []
      : [{ start, duration: end - start, text, owner: video.id }]
  })
}

/**
 * 把 `wanted` 按开始时间一句句放进已有的字幕（`existing`）之间：和已有的（含先放进去的）重叠的那一句截短到
 * 它自己那段时间里没被占的最长一截（一样长取靠前的），不到最短长度就不要。答复放进去的和没放下的句数。
 */
export function placeCaptions(
  existing: readonly Span[],
  wanted: readonly NewCaption[],
): { placed: NewCaption[]; skipped: number } {
  const taken: Span[] = [...existing]
  const placed: NewCaption[] = []
  let skipped = 0
  for (const caption of wanted.toSorted((left, right) => left.start - right.start)) {
    const blockers = taken
      .filter((span) => overlaps(span, caption))
      .toSorted((left, right) => left.start - right.start)
    let cursor = caption.start
    let best: Span = { start: caption.start, duration: 0 }
    for (const free of [...blockers, { start: endOf(caption), duration: 0 }]) {
      const piece = { start: cursor, duration: Math.min(free.start, endOf(caption)) - cursor }
      if (piece.duration > best.duration) best = piece
      cursor = Math.max(cursor, endOf(free))
    }
    if (best.duration < MIN_CLIP_MS) {
      skipped += 1
      continue
    }
    const fitted = { ...caption, ...best }
    placed.push(fitted)
    taken.push(fitted)
  }
  return { placed, skipped }
}

/**
 * 将语音识别结果（视频片段 ID → 对应素材识别出的句子列表）换算为待加入轨道的字幕：
 * 先按各片段取它名下的句子并映射时间（见 `sentenceCaptions`），再经 `placeCaptions` 避让已有字幕。
 * `silent` 记录用掉的那段素材里没有一句话的片段 ID；`elsewhere` 记录用掉的那段素材里有话、但一句都没写到它名下
 * （句子都由播出开头的别的片段写）的片段 ID。
 */
export function recognizedCaptions(
  clips: readonly FilmClip[],
  sentencesOf: ReadonlyMap<string, readonly Sentence[]>,
): { captions: NewCaption[]; skipped: number; silent: string[]; elsewhere: string[] } {
  const silent: string[] = []
  const elsewhere: string[] = []
  const wanted = clips.flatMap((clip) => {
    const sentences = sentencesOf.get(clip.id)
    if (clip.kind !== 'video' || sentences === undefined) return []
    const own = sentenceCaptions(clip, sentences, clips)
    if (!sentences.some((sentence) => playsPart(clip, sentence))) silent.push(clip.id)
    else if (own.length === 0) elsewhere.push(clip.id)
    return own
  })
  const { placed, skipped } = placeCaptions(clips.filter(isCaption), wanted)
  return { captions: placed, skipped, silent, elsewhere }
}
