import type { DubbedLine, DubbingLine, DubbingSpeechSpan } from '@/shared/api/generated/types.gen'
import { zSpeechIn } from '@/shared/api/generated/zod.gen'
import {
  isDubClip,
  MIN_CLIP_MS,
  type AudioClip,
  type AudioDub,
  type CaptionClip,
  type FilmClip,
  type VideoClip,
} from './composition/film'
import type { VoiceMode } from './composition/voices'
import { phraseWith, SOURCE_NAME, type Language } from './locales'
import type { Voicing } from './voice-lines'

/**
 * 在语言 `locale`（人声设置 `mode`）下显示的片段，和出声的一样（见 `voices.ts` 的 `localizedVoices`，`owned` 是属于
 * 视频片段的字幕）：其它语言的配音片段只在这种语言配音时显示这种语言的；原文的配音片段在原文配音时都显示，别的
 * 时候只显示旁白；别的片段都显示。时间线、行名和同一行不能重叠都按显示着的片段算，不同时显示的配音在同一行同一
 * 时间不算重叠。
 */
export const shownIn =
  (locale: Language, mode: VoiceMode, owned: ReadonlySet<string>) =>
  (clip: FilmClip): boolean =>
    !isDubClip(clip) ||
    (clip.dub.locale === null
      ? (locale === null && mode === 'dub') || (mode === 'original' && !owned.has(clip.dub.caption))
      : mode === 'dub' && clip.dub.locale === locale)

/**
 * 要配的一句：在素材片视频里的起止（毫秒）、译文和最晚占到哪儿（`slotEndMs`：这条素材片上下一句要配音的字幕的
 * 开始，和时间线上它后面下一句有旁白要配音的字幕的开始，取早的，不管它们用哪个音色；都没有就不写），`caption`
 * 是它配的那句字幕。
 */
export type DubLine = DubbingLine & { caption: string }

/**
 * 一次配音请求：素材片地址、用的音色（null 是原声的音色）、按开始排好、不重叠的各句，和这条素材片里有人说话的
 * 时段（`spans`：它的视频片段名下全部字幕的时段，不管翻没翻、配不配；同一条素材片的每次请求都是同一份，
 * 用原声的音色时服务端按它截参考，这次只配几句也截同一段）。
 */
export type DubbingRequest = {
  src: string
  voice: string | null
  lines: readonly DubLine[]
  spans: readonly DubbingSpeechSpan[]
}

/** 为什么一条素材片都配不了：没有视频片段、视频片段都没有识别出的字幕、字幕一句都没翻（原文是一句都没有字）。 */
export type DubbingRefusal = 'empty' | 'uncaptioned' | 'untranslated'

/** 配不了的原因，`code` 是要配的语言（原文是 null）。 */
export const dubbingRefusalText = (refusal: DubbingRefusal, code: Language): string =>
  refusal === 'empty'
    ? 'final-cut 中暂无视频片段，无法生成配音；请先添加镜头'
    : refusal === 'uncaptioned'
      ? `视频片段均无已识别字幕，无法生成配音；请先在「${SOURCE_NAME}」下点击「识别字幕」`
      : code === null
        ? '字幕均没有文字，无法生成配音'
        : phraseWith('字幕尚未翻译为', code, '，无法生成配音；请先点击「翻译」')

const isCaption = (clip: FilmClip): clip is CaptionClip => clip.kind === 'caption'

/** 一句为什么配不了音：还没翻（原文是没有字）、素材片对不上生成记录、和前一句重叠得放不下。 */
export type LineRefusal = 'untranslated' | 'untaken' | 'crowded'

/** 一句配不了音的原因，`code` 是要配的语言（原文是 null）。 */
export const lineRefusalText = (refusal: LineRefusal, code: Language): string =>
  refusal === 'untranslated'
    ? code === null
      ? '该条字幕没有文字，无法配音'
      : phraseWith('该条字幕尚未翻译为', code, '，无法配音；请先点击「翻译」')
    : refusal === 'untaken'
      ? '未找到该条字幕所属视频片段的素材片记录，无法配音'
      : '该条字幕与前一条重叠过多，无法配音'

/**
 * 要配的各句字幕（`voicing` 说用某个音色配的）在一种语言下为什么合成不了，合成得了的不在里面：没有字；属于视频
 * 片段的，素材片对不上生成记录（`hasTake`），或者每句都配音时排不进素材片的请求（不在 `dubbable` 里）。
 */
export function lineRefusals(
  clips: readonly FilmClip[],
  voicing: Voicing,
  dubbable: ReadonlySet<string>,
  hasTake: (src: string) => boolean,
): ReadonlyMap<string, LineRefusal> {
  const videos = new Map(
    clips.flatMap((clip) => (clip.kind === 'video' ? [[clip.id, clip] as const] : [])),
  )
  return new Map(
    clips.filter(isCaption).flatMap((caption): [string, LineRefusal][] => {
      if (voicing.voice(caption).kind !== 'voiced') return []
      if (voicing.text(caption) === '') return [[caption.id, 'untranslated']]
      const video = voicing.owned.has(caption.id) ? videos.get(caption.owner ?? '') : undefined
      if (video === undefined || dubbable.has(caption.id)) return []
      return [[caption.id, hasTake(video.src) ? 'crowded' : 'untaken']]
    }),
  )
}

const ALL_LINES = () => true

/**
 * 一种语言下要配音的字幕（`voicing` 说用某个音色配、有字的，不管用哪个音色），按开始排好。`narrated` 是其中的
 * 旁白句。
 */
const voicedCaptions = (
  clips: readonly FilmClip[],
  voicing: Voicing,
): { voiced: CaptionClip[]; narrated: ReadonlySet<string> } => {
  const voiced = clips
    .filter(isCaption)
    .filter((caption) => voicing.text(caption) !== '' && voicing.voice(caption).kind === 'voiced')
    .toSorted((a, b) => a.start - b.start)
  return {
    voiced,
    narrated: new Set(
      voiced.filter((caption) => !voicing.owned.has(caption.id)).map(({ id }) => id),
    ),
  }
}

/** 一句要用的音色；不配时是 undefined。 */
const voiceIn = (voicing: Voicing, caption: CaptionClip): string | null | undefined => {
  const voice = voicing.voice(caption)
  return voice.kind === 'voiced' ? voice.voice : undefined
}

/** 时间线上 `start` 以后开始的下一句（`voiced` 按开始排好），只看 `which` 挑的；没有时是 undefined。 */
const nextVoiced = (
  voiced: readonly CaptionClip[],
  start: number,
  which: (caption: CaptionClip) => boolean = ALL_LINES,
): CaptionClip | undefined => voiced.find((other) => other.start > start && which(other))

/** 说话时段按开始排好，重叠的并成一段（同一段素材用在两个视频片段里时会重叠），没有长度的不要。 */
const mergedSpans = (spans: readonly DubbingSpeechSpan[]): DubbingSpeechSpan[] => {
  const merged: DubbingSpeechSpan[] = []
  for (const span of spans.toSorted((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1)
    if (span.endMs <= span.startMs) continue
    if (last !== undefined && span.startMs < last.endMs)
      merged[merged.length - 1] = { ...last, endMs: Math.max(last.endMs, span.endMs) }
    else merged.push(span)
  }
  return merged
}

/**
 * 一种语言（每句怎么配见 `voicing`）下的配音请求：每条素材片取用它的视频片段名下的字幕（识别出来、属于这个片段
 * 的），用这种语言的字，没字的不配，`voicing` 说不配的不配。字幕的时间换算到素材片视频里：
 * `入点 + (字幕时间 − 片段开始) × 速度`，收在 0 到素材片总长（`sourceMs`，读不到时不收）之间；按开始排好，
 * 和前一句重叠的从前一句结尾开始，不到最短长度的不要；每句最晚占到这条素材片上下一句的开始，和时间线上它后面
 * 下一句要配音的旁白句（见 `narrationRequests`）的开始按同样的换算，取早的；那句旁白在这句的视频片段结尾以后
 * 时不算。排好以后只留 `picked` 挑中的句子，按素材片和音色分成几次请求（没有挑中的句子时是空的）。每次请求带着
 * 这条素材片的说话时段：全部字幕按同样的换算，按开始排好，重叠的并成一段。一句都没字时答复原因。
 */
export function dubbingRequests(
  clips: readonly FilmClip[],
  voicing: Voicing,
  sourceMs: (src: string) => number | undefined,
  picked: (caption: string) => boolean = ALL_LINES,
): { requests: readonly DubbingRequest[] } | { refusal: DubbingRefusal } {
  const videos = clips.filter((clip): clip is VideoClip => clip.kind === 'video')
  if (videos.length === 0) return { refusal: 'empty' }
  const owners = new Map(videos.map((video) => [video.id, video]))
  const owned = clips.filter(isCaption).filter((caption) => voicing.owned.has(caption.id))
  if (owned.length === 0) return { refusal: 'uncaptioned' }
  const bySource = new Map<string, DubLine[]>()
  const spoken = new Map<string, DubbingSpeechSpan[]>()
  const { voiced, narrated } = voicedCaptions(clips, voicing)
  const voices = new Map(owned.map((caption) => [caption.id, voiceIn(voicing, caption)]))
  // 各句到时间线上下一句旁白的开始在素材片里是多少毫秒
  const beforeNarration = new Map<string, number>()
  let translated = false
  for (const caption of owned) {
    const video = owners.get(caption.owner ?? '')
    if (video === undefined) continue
    const limit = sourceMs(video.src) ?? Infinity
    const at = (ms: number) =>
      Math.round(
        Math.min(limit, Math.max(0, video.mediaStart + (ms - video.start) * video.playbackRate)),
      )
    const span = { startMs: at(caption.start), endMs: at(caption.start + caption.duration) }
    spoken.set(video.src, [...(spoken.get(video.src) ?? []), span])
    const text = voicing.text(caption)
    if (text === '') continue
    translated = true
    if (voices.get(caption.id) === undefined) continue
    const narration = nextVoiced(voiced, caption.start, (other) => narrated.has(other.id))
    if (narration !== undefined && narration.start < video.start + video.duration)
      beforeNarration.set(caption.id, at(narration.start))
    const line = { ...span, text, caption: caption.id }
    bySource.set(video.src, [...(bySource.get(video.src) ?? []), line])
  }
  if (!translated) return { refusal: 'untranslated' }
  const groups = new Map<string, DubbingRequest & { lines: DubLine[] }>()
  for (const [src, lines] of bySource) {
    const spans = mergedSpans(spoken.get(src) ?? [])
    const kept: DubLine[] = []
    for (const line of lines.toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
      const startMs = Math.max(line.startMs, kept.at(-1)?.endMs ?? 0)
      if (line.endMs - startMs >= MIN_CLIP_MS) kept.push({ ...line, startMs })
    }
    for (const [index, line] of kept.entries()) {
      const voice = voices.get(line.caption)
      if (!picked(line.caption) || voice === undefined) continue
      const slotEndMs = Math.min(
        kept[index + 1]?.startMs ?? Infinity,
        beforeNarration.get(line.caption) ?? Infinity,
      )
      const key = JSON.stringify([src, voice])
      const group = groups.get(key) ?? { src, voice, lines: [], spans }
      group.lines.push(slotEndMs === Infinity ? line : { ...line, slotEndMs })
      groups.set(key, group)
    }
  }
  return { requests: [...groups.values()] }
}

const narrationTextLimit = (): number => {
  const max = zSpeechIn.shape.text.maxLength
  if (max === null) throw new Error('合同里按文字合成的语音没有字数上限')
  return max
}

/** 一句旁白文案最多几个字：直接读合同（和配音每句的上限一样）。字数按 `length` 算，只会比服务端算的多。 */
export const NARRATION_TEXT_LIMIT = narrationTextLimit()

/**
 * 要合成的一句旁白：配的哪句字幕（原文下「旁白配音」新加的旁白还没有字幕，是 null）、念的字、用的参考音频库
 * 音色，和最长多少毫秒（`maxMs`，不限时没有）。
 */
export type NarrationLine = { caption: string | null; text: string; voice: string; maxMs?: number }

/**
 * 一种语言（每句怎么配见 `voicing`）下要给旁白句配的句子：要配音的旁白句（`voicing` 说用参考音频库的某个音色配、
 * 有字的）里 `picked` 挑中的，用这种语言的字。最晚占到时间线上它后面下一句要配音的字幕（见 `voicedCaptions`，
 * 不管用哪个音色、挑没挑中）的开始；后面没有了时不限。
 */
export function narrationRequests(
  clips: readonly FilmClip[],
  voicing: Voicing,
  picked: (caption: string) => boolean = ALL_LINES,
): NarrationLine[] {
  const { voiced, narrated } = voicedCaptions(clips, voicing)
  return voiced.flatMap((caption): NarrationLine[] => {
    const voice = voiceIn(voicing, caption)
    if (!narrated.has(caption.id) || !picked(caption.id) || typeof voice !== 'string') return []
    const next = nextVoiced(voiced, caption.start)
    const line = { caption: caption.id, text: voicing.text(caption), voice }
    return [next === undefined ? line : { ...line, maxMs: next.start - caption.start }]
  })
}

/**
 * 一种语言下的配音：素材片的请求（见 `dubbingRequests`）和旁白句的句子（见 `narrationRequests`）。素材片配不了、
 * 也没有要配的旁白句时答复素材片配不了的原因。
 */
export function dubbingPlanOf(
  clips: readonly FilmClip[],
  voicing: Voicing,
  sourceMs: (src: string) => number | undefined,
  picked: (caption: string) => boolean = ALL_LINES,
):
  | { requests: readonly DubbingRequest[]; narrations: readonly NarrationLine[] }
  | { refusal: DubbingRefusal } {
  const takes = dubbingRequests(clips, voicing, sourceMs, picked)
  const narrations = narrationRequests(clips, voicing, picked)
  if (!('refusal' in takes)) return { requests: takes.requests, narrations }
  return narrations.length > 0 ? { requests: [], narrations } : takes
}

/** 合成好的一段旁白：地址、时长（毫秒）、加速的倍数和截没截尾。 */
export type SpokenAudio = {
  url: string
  durationMs: number | null
  speed: number
  trimmed: boolean
}

/**
 * 给旁白句配好的音（`spoken`：各句和合成好的音频）按 `clips`（这一刻的片段）建成配音片段：和它配的那句字幕对齐，
 * 从音频开头放，长度是音频的长度（有上限时不超过它），记着念的字、音色和倍数。字幕已经不在、读不到时长、不到
 * 最短长度的不建。
 */
export function narrationDubs(
  clips: readonly FilmClip[],
  spoken: readonly { line: NarrationLine; audio: SpokenAudio }[],
): NewDub[] {
  const captions = new Map(clips.filter(isCaption).map((caption) => [caption.id, caption]))
  return spoken.flatMap(({ line, audio }) => {
    const caption = captions.get(line.caption ?? '')
    if (caption === undefined || audio.durationMs === null) return []
    const duration = Math.min(audio.durationMs, line.maxMs ?? Infinity)
    if (duration < MIN_CLIP_MS) return []
    return [
      {
        caption: caption.id,
        label: `配音 · ${line.text}`,
        src: audio.url,
        start: caption.start,
        duration,
        mediaStart: 0,
        playbackRate: 1,
        trimmed: audio.trimmed,
        text: line.text,
        voice: line.voice,
        speed: audio.speed,
      },
    ]
  })
}

/**
 * 待加入轨道的配音片段（落位行由会话按配音行规则决定，见 `dubRowFor`），带着合成时的记录（念的字、音色、倍数，
 * 见 `AudioDub`）。
 */
export type NewDub = Pick<
  AudioClip,
  'label' | 'src' | 'start' | 'duration' | 'mediaStart' | 'playbackRate'
> &
  Pick<AudioDub, 'caption' | 'trimmed' | 'voice' | 'speed'> & { text: string }

/** 素材片已完成配音记录的关键信息：音轨地址、总时长（毫秒）与单句结果列表。 */
export type DubbedTrack = { url: string; durationMs: number | null; lines: readonly DubbedLine[] }

/**
 * 根据当前工程片段 `clips` 将单条素材片的配音结果（`request` 为发起请求，`track` 为产出音轨）构建为配音片段：
 * 每句与对应字幕起点对齐、沿用所属视频片段的播放倍速；长度按 `slotEndMs`（缺省为音轨结尾）经倍速换算，
 * 上限取所属视频片段结尾与该句字幕结尾的较晚者（跨镜头识别的字幕长于其归属片段时确保配音完整播放）。
 * 对应字幕或视频片段已移除、或可用时长不足最短片段时长的条目不生成，截尾条目保留标记。每段记着请求里这句念的字、
 * 请求的音色和这句的加速倍数（见 `AudioDub`）。
 */
export function dubClips(
  clips: readonly FilmClip[],
  request: DubbingRequest,
  track: DubbedTrack,
): NewDub[] {
  const byId = new Map(clips.map((clip) => [clip.id, clip]))
  return request.lines.flatMap((line, index) => {
    const caption = byId.get(line.caption)
    const video = caption?.kind === 'caption' ? byId.get(caption.owner ?? '') : undefined
    const result = track.lines.find((each) => each.index === index)
    if (caption === undefined || video?.kind !== 'video') return []
    // 后续句起点不早于 slotEndMs，与后端槽位计算规则保持一致。
    const slotEnd = line.slotEndMs ?? track.durationMs ?? line.endMs
    const duration = Math.min(
      Math.round((slotEnd - line.startMs) / video.playbackRate),
      Math.max(video.start + video.duration, caption.start + caption.duration) - caption.start,
    )
    if (duration < MIN_CLIP_MS) return []
    return [
      {
        caption: caption.id,
        label: `配音 · ${line.text}`,
        src: track.url,
        start: caption.start,
        duration,
        mediaStart: line.startMs,
        playbackRate: video.playbackRate,
        trimmed: result?.trimmed ?? false,
        text: line.text,
        voice: request.voice,
        speed: result?.speed ?? 1,
      },
    ]
  })
}

/**
 * 语言 `locale`（原文是 null）下配的是 `captions` 里这几句字幕的配音片段：重新配好这几句时换掉它们，不配音时删掉
 * 它们。
 */
export function dubsOf(
  clips: readonly FilmClip[],
  locale: string | null,
  captions: Iterable<string>,
): string[] {
  const wanted = new Set(captions)
  return clips
    .filter((clip) => isDubClip(clip) && clip.dub.locale === locale && wanted.has(clip.dub.caption))
    .map((clip) => clip.id)
}

/** 收掉不超过这么多毫秒时不标截尾：时间换算取整的误差，听不出来。 */
const ROUNDING_SLACK_MS = 20

/**
 * 语言 `locale`（原文是 null）里新加 `added` 这几个配音片段时，要收短的已有配音片段（编号 → 收到多长（毫秒）和
 * 要不要标成截了尾）：`clips` 里这种语言、配别的句子的配音片段，开始得比一个新片段早、结尾超过它的开始时，收到新
 * 片段的开始（压住几个时收到最早的那个）；收短后不到最短长度的不收；收掉的不超过 `ROUNDING_SLACK_MS` 时照样收短、
 * 但不标。只在时间线上截尾，不重新合成。
 */
export function dubsOverlapped(
  clips: readonly FilmClip[],
  locale: string | null,
  added: readonly Pick<NewDub, 'caption' | 'start'>[],
): ReadonlyMap<string, { duration: number; trimmed: boolean }> {
  const captions = new Set(added.map((dub) => dub.caption))
  const trims = new Map<string, { duration: number; trimmed: boolean }>()
  for (const clip of clips) {
    if (!isDubClip(clip) || clip.dub.locale !== locale || captions.has(clip.dub.caption)) continue
    const covered = added
      .filter((dub) => clip.start < dub.start && dub.start < clip.start + clip.duration)
      .map((dub) => dub.start - clip.start)
    const duration = Math.min(...covered)
    if (covered.length > 0 && duration >= MIN_CLIP_MS)
      trims.set(clip.id, { duration, trimmed: clip.duration - duration > ROUNDING_SLACK_MS })
  }
  return trims
}
