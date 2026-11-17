import type { DubbedLine, DubbingLine } from '@/shared/api/generated/types.gen'
import {
  isDubClip,
  MIN_CLIP_MS,
  type AudioClip,
  type CaptionClip,
  type FilmClip,
  type VideoClip,
} from './composition/film'
import {
  phraseWith,
  SOURCE_NAME,
  translationOf,
  type Language,
  type LocaleCode,
  type LocaleValues,
} from './locales'

/**
 * 在语言 `locale` 下显示的片段：配音片段只显示这种语言的，原文下一个都不显示（也就没有配音行）；别的片段都显示。
 * 时间线、行名和同一行不能重叠都按显示着的片段算，不同语言的配音在同一行同一时间不算重叠。
 */
export const shownIn =
  (locale: Language) =>
  (clip: FilmClip): boolean =>
    !isDubClip(clip) || clip.dub.locale === locale

/** 要配的一句：在素材片视频里的起止（毫秒）和译文，`caption` 是它配的那句字幕。 */
export type DubLine = DubbingLine & { caption: string }

/** 一条素材片要配的：素材片地址和按开始排好、不重叠的各句。 */
export type DubbingRequest = { src: string; lines: readonly DubLine[] }

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

/**
 * 一种语言（值表 `values`）下要配音的素材片：每条素材片取用它的视频片段名下的字幕（识别出来、属于这个片段的），
 * 用这种语言的字，没翻的不配。字幕的时间换算到素材片视频里：`入点 + (字幕时间 − 片段开始) × 速度`，收在
 * 0 到素材片总长（`sourceMs`，读不到时不收）之间；按开始排好，和前一句重叠的从前一句结尾开始，不到最短长度的
 * 不要。一条都配不了时答复原因。
 */
export function dubbingRequests(
  clips: readonly FilmClip[],
  values: LocaleValues,
  sourceMs: (src: string) => number | undefined,
): { requests: readonly DubbingRequest[] } | { refusal: DubbingRefusal } {
  const videos = clips.filter((clip): clip is VideoClip => clip.kind === 'video')
  if (videos.length === 0) return { refusal: 'empty' }
  const owners = new Map(videos.map((video) => [video.id, video]))
  const owned = clips.filter(isCaption).filter((caption) => owners.has(caption.owner ?? ''))
  if (owned.length === 0) return { refusal: 'uncaptioned' }
  const bySource = new Map<string, DubLine[]>()
  for (const caption of owned) {
    const video = owners.get(caption.owner ?? '')
    const text = translationOf(values, caption.variable)?.trim() ?? ''
    if (video === undefined || text === '') continue
    const limit = sourceMs(video.src) ?? Infinity
    const at = (ms: number) =>
      Math.round(
        Math.min(limit, Math.max(0, video.mediaStart + (ms - video.start) * video.playbackRate)),
      )
    const line = {
      startMs: at(caption.start),
      endMs: at(caption.start + caption.duration),
      text,
      caption: caption.id,
    }
    bySource.set(video.src, [...(bySource.get(video.src) ?? []), line])
  }
  const requests = [...bySource].flatMap(([src, lines]) => {
    const kept: DubLine[] = []
    for (const line of lines.toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
      const startMs = Math.max(line.startMs, kept.at(-1)?.endMs ?? 0)
      if (line.endMs - startMs >= MIN_CLIP_MS) kept.push({ ...line, startMs })
    }
    return kept.length === 0 ? [] : [{ src, lines: kept }]
  })
  return requests.length === 0 ? { refusal: 'untranslated' } : { requests }
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
 * 长度照配音的规则占到下一句开始（最后一句到音轨结尾），再按速度换算，不超出那个视频片段的结尾。字幕或它的
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
    const slotEnd = request.lines[index + 1]?.startMs ?? track.durationMs ?? line.endMs
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

/**
 * 重新生成素材片 `src` 在语言 `locale` 下的配音时要换掉的配音片段：这种语言里配的是用这条素材片的视频片段名下
 * 字幕的那些。
 */
export function replacedDubs(clips: readonly FilmClip[], locale: string, src: string): string[] {
  const videos = new Set(
    clips.filter((clip) => clip.kind === 'video' && clip.src === src).map((clip) => clip.id),
  )
  const captions = new Set(
    clips
      .filter((clip) => isCaption(clip) && clip.owner !== null && videos.has(clip.owner))
      .map((clip) => clip.id),
  )
  return clips
    .filter(
      (clip) => isDubClip(clip) && clip.dub.locale === locale && captions.has(clip.dub.caption),
    )
    .map((clip) => clip.id)
}
