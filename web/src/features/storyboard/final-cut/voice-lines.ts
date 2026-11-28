import { isDubClip, type CaptionClip, type FilmClip } from './composition/film'
import {
  ownedCaptions,
  voiceOfLine,
  voiceSettingOf,
  type LineVoice,
  type VoiceModes,
} from './composition/voices'
import { translationOf, type Language, type ShownLocale } from './locales'

/**
 * 一句在一种语言下的人声：保留原声（由视频自己说，或这种语言用着原声）、设成不配音、还没有音色可用，或者用
 * `voice` 配（参考音频库音色的编号；null 是从素材片的原声里取，只有属于视频片段的句子会这样）。
 */
export type LineVoicing =
  | { kind: 'original' }
  | { kind: 'unvoiced' }
  | { kind: 'voiceless' }
  | { kind: 'voiced'; voice: string | null }

/**
 * 一种语言下每句怎么配：`owned` 是属于视频片段的字幕（见 `ownedCaptions`，别的是旁白句），`text` 是这句在这种
 * 语言下念的字（去掉两头空白；外语没翻是空串），`voice` 是它的人声（见 `voicingOf`）。
 */
export type Voicing = {
  owned: ReadonlySet<string>
  text: (caption: CaptionClip) => string
  voice: (caption: CaptionClip) => LineVoicing
}

const isCaption = (clip: FilmClip): clip is CaptionClip => clip.kind === 'caption'

/** `clips` 里属于视频片段的字幕（见 `ownedCaptions`），别的字幕是旁白句。 */
export const ownedIn = (clips: readonly FilmClip[]): ReadonlySet<string> =>
  ownedCaptions(
    clips.filter(isCaption),
    clips.flatMap((clip) => (clip.kind === 'video' ? [clip.id] : [])),
  )

const ownLine = (lines: Readonly<Record<string, LineVoice>>, caption: string) =>
  Object.hasOwn(lines, caption) ? lines[caption] : undefined

const voiced = (voice: string | null | undefined): LineVoicing =>
  voice === undefined ? { kind: 'voiceless' } : { kind: 'voiced', voice }

/**
 * 语言 `shown` 下每句怎么配（`clips` 要含所有语言的配音片段，`modes` 是主文件根上的人声设置）：
 * - 属于视频片段的句子：这种语言原声时保留原声；配音时按自己的选择，没选的跟着这种语言的音色，选了不配音的不配；
 * - 旁白句：外语原声时保留原声（放的是原文的旁白）；选了不配音的不配；原文原声时只用它自己的音色；配音时按自己
 *   的选择或这种语言的音色，取到原声的音色（null）时用它自己的音色。
 * 旁白句自己的音色：原文下给它选的参考音频库音色，没选时是它原文的配音片段记着的音色；都没有时还没有音色可用。
 */
export function voicingOf(
  clips: readonly FilmClip[],
  modes: VoiceModes,
  shown: ShownLocale,
): Voicing {
  const owned = ownedIn(clips)
  const recorded = new Map(
    clips.flatMap((clip) =>
      isDubClip(clip) && clip.dub.locale === null && clip.dub.voice !== null
        ? [[clip.dub.caption, clip.dub.voice] as const]
        : [],
    ),
  )
  const setting = voiceSettingOf(modes, shown.code)
  const source = voiceSettingOf(modes, null)
  const ownVoice = (caption: string): string | undefined => {
    const line = ownLine(source.lines, caption)
    const chosen = line !== undefined && 'voice' in line ? line.voice : null
    return chosen ?? recorded.get(caption)
  }
  return {
    owned,
    text: (caption) =>
      (shown.values === null
        ? caption.text
        : (translationOf(shown.values, caption.variable) ?? '')
      ).trim(),
    voice: (caption) => {
      const isOwned = owned.has(caption.id)
      const sourceOriginal = shown.code === null && setting.mode === 'original'
      if (setting.mode === 'original' && (isOwned || !sourceOriginal)) return { kind: 'original' }
      const chosen = voiceOfLine(setting, caption.id)
      if (chosen === undefined) return { kind: 'unvoiced' }
      if (isOwned) return { kind: 'voiced', voice: chosen }
      return voiced(sourceOriginal ? ownVoice(caption.id) : (chosen ?? ownVoice(caption.id)))
    },
  }
}

/**
 * 一句的配音状态：保留原声、不配音、还没有音色可用（要先选音色）、要配还没配、正在合成、过期（配音片段记着的字或
 * 音色和现在的不一样）、已配好。
 */
export type LineStatus =
  'original' | 'unvoiced' | 'voiceless' | 'missing' | 'running' | 'stale' | 'ready'

/**
 * 一句在一种语言下的样子：`status` 见 `LineStatus`；`own` 是这句自己的选择（跟着这种语言的音色时是 undefined）；
 * `voice` 是要用的音色（`voicing` 是 voiced 时的，别的时候是 undefined）；已有配音片段时 `speed` 是它合成时加速的倍数、
 * `trimmed` 是它截没截尾（没有配音时是 null、false）；`pending` 是它待不待处理（要配还没配的和过期的，配得了的；在合成
 * 别的句子时照样算，「重配 N 句」的 N 数的就是它）；`blocked` 是现在为什么不能给它单独合成（含在合成别的）；
 * `chooseBlocked` 是为什么不能给它选音色（保留原声的句子不能选）。
 */
export type LineState = {
  status: LineStatus
  own: LineVoice | undefined
  voice: string | null | undefined
  speed: number | null
  trimmed: boolean
  pending: boolean
  blocked: string | undefined
  chooseBlocked: string | undefined
}

/** 一种语言的汇总：有没有任何配音片段、待处理（要配还没配的和过期的、合成得了的）几句、还剩几句在合成。 */
export type VoiceSummary = { dubbed: boolean; pending: number; running: number }

const ORIGINAL_TEXT = '该条字幕保留原声，无法单独配音'

/** 不配的句子为什么不能单独合成。 */
const UNSENT: Record<Exclude<LineVoicing['kind'], 'voiced'>, string> = {
  original: ORIGINAL_TEXT,
  unvoiced: '该条字幕已设为不配音',
  voiceless: '该条字幕还没有可用的音色，请先选择音色',
}

/**
 * 各句字幕在语言 `locale` 下的样子（见 `LineState`），按字幕编号：`clips` 要含所有语言的配音片段，`voicing` 见
 * `voicingOf`，`lines` 是这种语言里各句自己的选择，`running` 是正在合成的句子（这种语言的），`refusal` 是一句要配
 * 却合成不了的原因（没翻、素材片对不上、太挤，见 `lineRefusals`），`busy` 是现在为什么什么都合成不了（在合成
 * 别的、在读素材片……）。过期只看有记录的配音片段（见 `AudioDub`）：字是这句现在的字、音色是现在要用的音色时不过期。
 */
export function lineStates({
  clips,
  locale,
  voicing,
  lines,
  running,
  refusal,
  busy,
}: {
  clips: readonly FilmClip[]
  locale: Language
  voicing: Voicing
  lines: Readonly<Record<string, LineVoice>>
  running: ReadonlySet<string>
  refusal: (caption: string) => string | undefined
  busy: string | undefined
}): ReadonlyMap<string, LineState> {
  const dubs = new Map(
    clips.flatMap((clip) =>
      isDubClip(clip) && clip.dub.locale === locale ? [[clip.dub.caption, clip.dub] as const] : [],
    ),
  )
  return new Map(
    clips.filter(isCaption).map((caption): [string, LineState] => {
      const voicingNow = voicing.voice(caption)
      const dub = dubs.get(caption.id)
      const voice = voicingNow.kind === 'voiced' ? voicingNow.voice : undefined
      const text = voicing.text(caption)
      const status: LineStatus =
        voicingNow.kind !== 'voiced'
          ? voicingNow.kind
          : running.has(caption.id)
            ? 'running'
            : dub === undefined
              ? 'missing'
              : dub.text !== null && (dub.text !== text || dub.voice !== voice)
                ? 'stale'
                : 'ready'
      // 配不了的原因只看这句自己；在合成别的只挡住现在发起，不改它待不待处理
      const refused = voicingNow.kind === 'voiced' ? refusal(caption.id) : UNSENT[voicingNow.kind]
      return [
        caption.id,
        {
          status,
          own: ownLine(lines, caption.id),
          voice,
          speed: dub?.speed ?? null,
          trimmed: dub?.trimmed ?? false,
          pending: (status === 'missing' || status === 'stale') && refused === undefined,
          blocked: voicingNow.kind === 'voiced' ? (busy ?? refused) : refused,
          chooseBlocked: voicingNow.kind === 'original' ? ORIGINAL_TEXT : undefined,
        },
      ]
    }),
  )
}

/**
 * 语言 `locale` 的汇总（见 `VoiceSummary`）：`states` 是各句的样子（见 `lineStates`），`running` 是这种语言还剩几句
 * 在合成（见 `useDubbing` 的 `remaining`）。
 */
export function voiceSummary(
  clips: readonly FilmClip[],
  locale: Language,
  states: ReadonlyMap<string, LineState>,
  running: number,
): VoiceSummary {
  return {
    dubbed: clips.some((clip) => isDubClip(clip) && clip.dub.locale === locale),
    pending: [...states.values()].filter((state) => state.pending).length,
    running,
  }
}

/**
 * 一段配音的倍速写法：截了尾的是「倍速 · 截尾」；加速了的是倍数，两位小数去掉末尾的 0（`1.18×`、`1.2×`）；没加速、
 * 或去掉小数后就是 1 的，没有写法（undefined）。加速的上限由服务端定，这里不管。
 */
export function speedText(speed: number, trimmed: boolean): string | undefined {
  if (trimmed) return '倍速 · 截尾'
  const shown = Number(speed.toFixed(2))
  return shown > 1 ? `${shown}×` : undefined
}

/** 倍速写法（`text`，见 `speedText`）的悬停说明：为什么加速了，截了尾时该怎么办。 */
export const speedTip = (text: string, trimmed: boolean) =>
  trimmed
    ? '配音加速到上限仍超出本句时长，已截掉结尾；请精简文字或拉长字幕'
    : `配音比本句时长长，已加速到 ${text} 播放`
