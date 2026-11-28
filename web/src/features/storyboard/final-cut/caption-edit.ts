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
  taken: '播放头位置已有字幕，无法继续添加；请将播放头移至无字幕区间',
  tight: '播放头距下一条字幕不足 0.1 秒，无法添加字幕；请将播放头前移',
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

/** 「字幕」页签里的两段：「字幕」和「画面文字」。 */
export type CaptionsView = 'captions' | 'texts'

/**
 * 选中的片段在「字幕」里对应什么：`lines` 是列表里要标成当前的字幕（选中的字幕，和选中的配音片段配的那句，
 * 旁白也算）；`view` 是该切到哪一段：选中了字幕或配音片段时是「字幕」，不然选中了有文字字段的元素、模板片段（编号在
 * `textHosts` 里）时是「画面文字」，都没有时是 undefined、不切。
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
  overlap: '字幕联动移动后将与其他字幕重叠，无法完成本次编辑；请先移开或移除冲突字幕',
  early: '字幕随配音片段移动后将早于 0 秒，无法完成本次编辑；请将配音片段后移',
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
  empty: 'final-cut 中暂无视频片段，无法识别字幕；请先添加镜头',
  captioned: '所有视频片段均已有字幕，无需重复识别；移除某一视频片段的全部字幕后可重新识别',
  unusable: '所有视频片段均已静音或无对应素材记录，无法识别字幕；请先开启原声',
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

/** 语音识别产出的单句：在源素材中的起止时刻（毫秒）与识别文本。 */
export type Sentence = Pick<SubtitleSentence, 'startMs' | 'endMs' | 'text'>

/** 待加入轨道的单句字幕：起止时间（毫秒）、文本及归属的视频片段 ID（手动添加时为 `null`）。 */
export type NewCaption = Span & { text: string; owner: string | null }

/** 判断视频片段所播放的素材区间（`[mediaStart, mediaStart + duration * playbackRate)`）是否包含时刻 `ms`。 */
const playsAt = (video: VideoClip, ms: number) =>
  video.mediaStart <= ms && ms < video.mediaStart + video.duration * video.playbackRate

/** 判断视频片段所播放的素材区间与句子在源素材中的时间区间是否存在重叠。 */
const playsPart = (video: VideoClip, sentence: Sentence) =>
  video.mediaStart < sentence.endMs &&
  sentence.startMs < video.mediaStart + video.duration * video.playbackRate

/**
 * 计算归属视频片段 `video` 的待写入字幕（每句一条完整文本）：
 * - 句子仅归属播放其起点的有声片段，避免跨镜头的一句话在相邻片段下重复生成；
 * - 若句子起点未被任何同源有声片段播放（被裁去），则归属时间线上首个播放其部分内容的有声片段；
 * - 映射时间按 `片段起点 + (句子时刻 − 入点) ÷ 速度` 计算：起点被裁时截断至片段起点，终点保留句子完整结尾；
 * - 空文本及短于最短片段时长的条目将被忽略。`clips` 为工程全部片段，用于定位同源有声视频片段。
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
 * 按起始时间依次将 `wanted` 填入 `existing` 字幕之间的空隙：与已有字幕（含已放置项）重叠时，
 * 截取其自身区间内最长的空闲子段（等长取靠前者）；剩余时长不足最短片段时长则跳过。返回成功放置的字幕与跳过句数。
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
 * 先按各片段提取归属句子并映射时间（见 `sentenceCaptions`），再经 `placeCaptions` 避让已有字幕。
 * `silent` 记录所播素材区间内无任何口播句子的片段 ID；`elsewhere` 记录所播素材区间内有口播但句子均归属
 * 其他播放起点片段的片段 ID。
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
