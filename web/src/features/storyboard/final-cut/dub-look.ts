import type { ReferenceAudio } from '@/shared/api/reference-audios'
import type { IconName } from '@/shared/icons'
import { isDubClip, type FilmClip } from './composition/film'
import { ORIGINAL_VOICE_NAME, voiceNameOf, type VoiceControl } from './voice-choices'
import { speedText } from './voice-lines'

/** 时间线上一个配音片段顶行写什么、整块要不要画淡。 */
export type DubLook = {
  /** 合成它用的音色名；从素材片原声里取的是「原声」。 */
  voice: string
  /** 音色的小图标；null 时画人声图标。 */
  glyph: IconName | null
  /** 加速倍数的写法（见 `speedText`）；没加速时是 undefined。 */
  speed: string | undefined
  /** 加速到上限还放不下、截了尾（倍数写成「倍速 · 截尾」，用提示色）。 */
  trimmed: boolean
  /** 过期：这句现在的字或音色和合成时的不一样（见 `LineState`）。 */
  stale: boolean
}

/**
 * 各配音片段顶行的样子，按片段编号。倍数、截尾和过期按显示着的语言里各句的样子（`voice.lines`，见 `lineStates`）；
 * 不是这种语言的配音片段（外语原声时照样放的原文旁白）不在 `voice.lines` 里，倍数照片段自己记的、不算过期。
 * 音色名按片段合成时记下的音色，从资料库里找（`library` 还没读到时名字是兜底名）。
 */
export function dubLooksOf(
  clips: readonly FilmClip[],
  voice: Pick<VoiceControl, 'locale' | 'lines'> | undefined,
  library: readonly ReferenceAudio[] | undefined,
): ReadonlyMap<string, DubLook> {
  return new Map(
    clips.filter(isDubClip).map((clip): [string, DubLook] => {
      const { dub } = clip
      const state = voice?.locale === dub.locale ? voice.lines.get(dub.caption) : undefined
      const id = dub.voice
      const trimmed = state?.trimmed ?? dub.trimmed
      return [
        clip.id,
        {
          voice: id === null ? ORIGINAL_VOICE_NAME : voiceNameOf(id, library),
          glyph: null,
          speed: speedText(state?.speed ?? dub.speed, trimmed),
          trimmed,
          stale: state?.status === 'stale',
        },
      ]
    }),
  )
}
