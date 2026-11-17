import type { DubbedLine, DubbingLine, DubbingSpeechSpan } from '@/shared/api/generated/types.gen'
import {
  isDubClip,
  MIN_CLIP_MS,
  type AudioClip,
  type CaptionClip,
  type FilmClip,
  type VideoClip,
} from './composition/film'
import type { VoiceMode } from './composition/voices'
import {
  phraseWith,
  SOURCE_NAME,
  translationOf,
  type Language,
  type LocaleCode,
  type LocaleValues,
} from './locales'

/**
 * 在语言 `locale`（人声设置 `mode`）下显示的片段：配音片段只在这种语言 AI 配音时显示这种语言的，保留原声时、
 * 原文下一个都不显示（也就没有配音行）；别的片段都显示。时间线、行名和同一行不能重叠都按显示着的片段算，
 * 不同语言的配音在同一行同一时间不算重叠。
 */
export const shownIn =
  (locale: Language, mode: VoiceMode) =>
  (clip: FilmClip): boolean =>
    !isDubClip(clip) || (mode === 'dub' && clip.dub.locale === locale)

/**
 * 要配的一句：在素材片视频里的起止（毫秒）、译文和最晚占到哪儿（`slotEndMs`：这条素材片上下一句要配音的字幕的
 * 开始，不管它用哪个音色；后面没有了就不写），`caption` 是它配的那句字幕。
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

/** 一句用的音色（null 是原声的音色）；undefined 是这句不配音。 */
export type VoiceOfCaption = (caption: string) => string | null | undefined

/** 为什么一条素材片都配不了：没有视频片段、视频片段都没有识别出的字幕、字幕一句都没翻。 */
export type DubbingRefusal = 'empty' | 'uncaptioned' | 'untranslated'

/** 配不了的原因，`code` 是要配的语言。 */
export const dubbingRefusalText = (refusal: DubbingRefusal, code: LocaleCode): string =>
  refusal === 'empty'
    ? 'final-cut 里暂无视频片段，无法生成配音；请先加入镜头'
    : refusal === 'uncaptioned'
      ? `视频片段都没有识别出的字幕，无法生成配音；请先在「${SOURCE_NAME}」下点击「识别字幕」`
      : phraseWith('字幕还没有翻成', code, '，无法生成配音；请先点击「翻译」')

const isCaption = (clip: FilmClip): clip is CaptionClip => clip.kind === 'caption'

/** 一句为什么配不了音：不属于视频片段、还没翻、素材片对不上生成记录、和前一句重叠得放不下。 */
export type LineRefusal = 'unowned' | 'untranslated' | 'untaken' | 'crowded'

/** 一句配不了音的原因，`code` 是要配的语言。 */
export const lineRefusalText = (refusal: LineRefusal, code: LocaleCode): string =>
  refusal === 'unowned'
    ? '这句字幕不属于任何视频片段，无法配音'
    : refusal === 'untranslated'
      ? phraseWith('这句还没有翻成', code, '，无法配音；请先点击「翻译」')
      : refusal === 'untaken'
        ? '找不到这句所在视频片段的素材片记录，无法配音'
        : '这句和前一句重叠太多，无法配音'

/**
 * 各句字幕在一种语言（值表 `values`）下为什么配不了音，配得了的不在里面。`dubbable` 是每句都配音时排进了请求、
 * 素材片对得上生成记录（`hasTake`）的句子。
 */
export function lineRefusals(
  clips: readonly FilmClip[],
  values: LocaleValues,
  dubbable: ReadonlySet<string>,
  hasTake: (src: string) => boolean,
): ReadonlyMap<string, LineRefusal> {
  const videos = new Map(
    clips.flatMap((clip) => (clip.kind === 'video' ? [[clip.id, clip] as const] : [])),
  )
  return new Map(
    clips.filter(isCaption).flatMap((caption): [string, LineRefusal][] => {
      if (dubbable.has(caption.id)) return []
      const video = videos.get(caption.owner ?? '')
      const refusal: LineRefusal =
        video === undefined
          ? 'unowned'
          : (translationOf(values, caption.variable)?.trim() ?? '') === ''
            ? 'untranslated'
            : !hasTake(video.src)
              ? 'untaken'
              : 'crowded'
      return [[caption.id, refusal]]
    }),
  )
}

const ALL_LINES = () => true

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
 * 一种语言（值表 `values`）下的配音请求：每条素材片取用它的视频片段名下的字幕（识别出来、属于这个片段的），
 * 用这种语言的字，没翻的不配，`voiceOf` 说不配音的不配。字幕的时间换算到素材片视频里：
 * `入点 + (字幕时间 − 片段开始) × 速度`，收在 0 到素材片总长（`sourceMs`，读不到时不收）之间；按开始排好，
 * 和前一句重叠的从前一句结尾开始，不到最短长度的不要；每句最晚占到这条素材片上下一句的开始。排好以后只留
 * `picked` 挑中的句子，按素材片和音色分成几次请求（没有挑中的句子时是空的）。每次请求带着这条素材片的说话时段：
 * 全部字幕按同样的换算，按开始排好，重叠的并成一段。一句都没翻时答复原因。
 */
export function dubbingRequests(
  clips: readonly FilmClip[],
  values: LocaleValues,
  sourceMs: (src: string) => number | undefined,
  voiceOf: VoiceOfCaption,
  picked: (caption: string) => boolean = ALL_LINES,
): { requests: readonly DubbingRequest[] } | { refusal: DubbingRefusal } {
  const videos = clips.filter((clip): clip is VideoClip => clip.kind === 'video')
  if (videos.length === 0) return { refusal: 'empty' }
  const owners = new Map(videos.map((video) => [video.id, video]))
  const owned = clips.filter(isCaption).filter((caption) => owners.has(caption.owner ?? ''))
  if (owned.length === 0) return { refusal: 'uncaptioned' }
  const bySource = new Map<string, DubLine[]>()
  const spoken = new Map<string, DubbingSpeechSpan[]>()
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
    const text = translationOf(values, caption.variable)?.trim() ?? ''
    if (text === '') continue
    translated = true
    if (voiceOf(caption.id) === undefined) continue
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
      const voice = voiceOf(line.caption)
      if (!picked(line.caption) || voice === undefined) continue
      const following = kept[index + 1]
      const key = JSON.stringify([src, voice])
      const group = groups.get(key) ?? { src, voice, lines: [], spans }
      group.lines.push(following === undefined ? line : { ...line, slotEndMs: following.startMs })
      groups.set(key, group)
    }
  }
  return { requests: [...groups.values()] }
}

/** 要加进 final-cut 的一个配音片段（放在哪一行由会话按配音行的规则找，见 `dubRowFor`）。 */
export type NewDub = Pick<
  AudioClip,
  'label' | 'src' | 'start' | 'duration' | 'mediaStart' | 'playbackRate'
> & { caption: string; trimmed: boolean }

/** 一条素材片配好的配音记录里用得到的：音轨地址、总长（毫秒）和每句的结果。 */
export type DubbedTrack = { url: string; durationMs: number | null; lines: readonly DubbedLine[] }

/**
 * 一条素材片的配音（`request` 是发起时的各句，`track` 是配好的音轨）按 `clips`（这一刻的片段）建成配音片段：
 * 每句一个，和它配的那句字幕对齐（从字幕的开始放），从音轨里这句的开始放起，速度跟着字幕所属的视频片段；
 * 长度照配音的规则占到这句的 `slotEndMs`（没有时到音轨结尾），再按速度换算，不超出那个视频片段的结尾。字幕或它的
 * 视频片段已经不在、放不下最短长度的句子不建。截了尾的句子标出来。
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
    if (caption === undefined || video?.kind !== 'video') return []
    // 请求里的下一句不会早于 `slotEndMs`（它是这条素材片上下一句要配的开始），和后端的取法一样
    const slotEnd = line.slotEndMs ?? track.durationMs ?? line.endMs
    const duration = Math.min(
      Math.round((slotEnd - line.startMs) / video.playbackRate),
      video.start + video.duration - caption.start,
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
        trimmed: track.lines.some((each) => each.index === index && each.trimmed),
      },
    ]
  })
}

/** 语言 `locale` 下配的是 `captions` 里这几句字幕的配音片段：重新配好这几句时换掉它们，不配音时删掉它们。 */
export function dubsOf(
  clips: readonly FilmClip[],
  locale: string,
  captions: Iterable<string>,
): string[] {
  const wanted = new Set(captions)
  return clips
    .filter((clip) => isDubClip(clip) && clip.dub.locale === locale && wanted.has(clip.dub.caption))
    .map((clip) => clip.id)
}
