import {
  traitQuery,
  type AudioLocale,
  type AudioTraitFilter,
  type ReferenceAudio,
  type ReferenceAudioFilter,
} from '@/shared/api/reference-audios'
import type { LineVoice, VoiceMode } from './composition/voices'
import type { Language } from './locales'
import type { LineState, VoiceSummary } from './voice-lines'

/** 音色列表读取失败的原因及重试回调。 */
export type VoicesProblem = { message: string; onRetry: () => void }

/** 资料库里的全部音色（建立晚的在前，没读时是 undefined）及读取失败的提示：人声卡、旁白、单句菜单都从这里找名字和属性。 */
export type VoiceLibrary = {
  voices: readonly ReferenceAudio[] | undefined
  problem: VoicesProblem | undefined
}

/** 一个合成动作：`blocked` 是现在为什么不能做（能做时是 undefined），`run` 发起合成（不能做时不做事）。 */
export type DubAction = { blocked: string | undefined; run: () => void }

/**
 * 当前显示的语言（原文也是）的人声设置和配音：「字幕」页签只通过它读写配音。改模式、默认音色和单句的选择都只记在
 * 主文件里（各一步撤销），不合成；合成只由 `generate`、`fill`、`dubLine` 发起，同一时间只跑一批，配好后一步写进
 * 工程（换掉这些句子原来的配音片段）。
 */
export type VoiceControl = {
  /** 当前显示的语言；原文是 null。 */
  locale: Language
  /** 原声还是配音（见 `voices.ts`）。 */
  mode: VoiceMode
  /** 切换原声 / 配音，不合成；切到配音而还没配过时也不自动生成。 */
  onMode: (mode: VoiceMode) => void
  /** 默认音色：参考音频库音色的编号；null 是原片音色（从素材片的原声里取，旁白句用它自己的音色）。 */
  voice: string | null
  /** 记下默认音色并切到配音，一步撤销，不合成。 */
  onVoice: (voice: string | null) => void
  /** 各句的样子（字幕编号 → 见 `LineState`）：状态、自己的选择、要用的音色、倍速和不能合成 / 不能选音色的原因。 */
  lines: ReadonlyMap<string, LineState>
  /**
   * 改一句的选择（null 是去掉它自己的选择、跟着默认音色），一步撤销，不合成；设成不配音时一起删掉这句在这种语言下的
   * 配音片段。这句不能选音色（`chooseBlocked`）时不做事。
   */
  onLine: (caption: string, line: LineVoice | null) => void
  /** 汇总：有没有任何配音、待处理（「重配 N 句」的 N）几句、还剩几句在合成（正在合成这种语言时）。 */
  summary: VoiceSummary
  /** 整种语言生成：给要配音的句子全部合成，已配好的也重配。 */
  generate: DubAction
  /** 补齐：只合成待处理的句子（还没配的和过期的）。 */
  fill: DubAction
  /** 单句合成：只合成这一句；不能合成（见这句的 `blocked`）时不做事。 */
  dubLine: (caption: string) => void
}

/** 「原声」的显示名。 */
export const ORIGINAL_VOICE_NAME = '原声'

// 已选音色已从资料库移除或尚未加载时的兜底展示名
const LIBRARY_VOICE_NAME = '资料库音色'

/** 资料库音色的名字；查不到（被资料库移除或还没读到）时是兜底名「资料库音色」。 */
export const voiceNameOf = (id: string, library: readonly ReferenceAudio[] | undefined) =>
  library?.find((each) => each.id === id)?.title ?? LIBRARY_VOICE_NAME

/** 选某个默认音色（`null` 为原声）：`picked` 是不是正用着（配音且是这个音色），`pick` 记下它并切到配音（不合成）。 */
export const languageChoice = (voice: VoiceControl, id: string | null) => ({
  picked: voice.mode === 'dub' && voice.voice === id,
  pick: () => voice.onVoice(id),
})

/** 第 `caption` 句自己选过的配置；跟随默认音色时是 undefined。 */
export const ownLineVoice = (voice: VoiceControl, caption: string): LineVoice | undefined =>
  voice.lines.get(caption)?.own

/** 选音面板语种下拉的取值：某个语种（连带多语种的音色）、只看多语种（`none`）或全部。 */
export type PickerLocale = AudioLocale | 'none' | 'all'

/** 选音面板能按哪几项属性筛，按筛选行上的先后。 */
export const PICKER_TRAITS = ['scenario', 'gender', 'age'] as const

/** 常用音色最多几个（不算「原声」）。 */
const COMMON_LIMIT = 3

/** 选音面板的查询：只查音色，按语种（选某个语种时连带多语种）、属性和关键词（去掉两头空白）筛。 */
export const voicePickerFilter = ({
  locale,
  q,
  traits,
}: {
  locale: PickerLocale
  q: string
  traits: AudioTraitFilter
}): ReferenceAudioFilter => {
  const filter: ReferenceAudioFilter = {
    audioKind: 'voice',
    q: q.trim(),
    ...traitQuery(PICKER_TRAITS, traits),
  }
  if (locale !== 'all') filter.locale = locale === 'none' ? ['none'] : [locale, 'none']
  return filter
}

/**
 * 常用音色（不含「原声」）的编号，最多 3 个：先放本片这种语言已经用到的（`used` 按先后，一般是整体音色、再是各句单独选的，
 * 空的和重复的跳过），不够时用资料库里语种是 `locale` 或没设语种的音色补齐，按 `library` 的先后（新的在前）。
 */
export const commonVoices = (
  used: readonly (string | null | undefined)[],
  library: readonly ReferenceAudio[],
  locale: AudioLocale,
): string[] => {
  const picked: string[] = []
  for (const id of used)
    if (id !== null && id !== undefined && !picked.includes(id)) picked.push(id)
  for (const voice of library) {
    if (picked.length >= COMMON_LIMIT) break
    if ((voice.locale === null || voice.locale === locale) && !picked.includes(voice.id))
      picked.push(voice.id)
  }
  return picked.slice(0, COMMON_LIMIT)
}

/** 音色名字旁的语种小字：「EN」，没设语种的是「多语」。 */
export const voiceLocaleTag = (locale: ReferenceAudio['locale']) =>
  locale === null ? '多语' : locale.toUpperCase()
