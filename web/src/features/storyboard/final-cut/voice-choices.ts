import type {
  AudioLocale,
  AudioTraitFilter,
  ReferenceAudio,
  ReferenceAudioFilter,
} from '@/shared/api/reference-audios'
import type { LineVoice, LineVoices, VoiceMode } from './composition/voices'

/** 音色列表读取失败的原因及重试回调。 */
export type VoicesProblem = { message: string; onRetry: () => void }

/** 资料库里的全部音色（建立晚的在前，没读时是 undefined）及读取失败的提示：人声卡、旁白、单句菜单都从这里找名字和属性。 */
export type VoiceLibrary = {
  voices: readonly ReferenceAudio[] | undefined
  problem: VoicesProblem | undefined
}

/**
 * 译文语言下的人声配置与控制：`mode` 为当前人声模式，`voice` 为该语言默认配音音色（`null` 表示沿用原声音色），
 * `dubbed` 标识是否已有配音片段，`generating` / `narrating` 分别记录在途的素材片配音数与旁白合成数（空闲时为 0）；
 * `generateBlocked` / `redoBlocked` 为换音色生成与重新生成的禁用原因；`lines` 与 `lineBlocked` 为单句级覆盖配置及禁用原因。
 */
export type VoiceControl = {
  mode: VoiceMode
  voice: string | null
  dubbed: boolean
  generating: number
  narrating: number
  generateBlocked: string | undefined
  redoBlocked: string | undefined
  lines: LineVoices
  lineBlocked: ReadonlyMap<string, string>
  onMode: (mode: VoiceMode) => void
  /** 切换当前语言默认音色（`null` 表示原声音色）并重配跟随默认音色的字幕句（已有配音时替换）。 */
  onGenerate: (voice: string | null) => void
  /** 按各句当前配置的音色重新生成全部待配音句子的配音。 */
  onRedo: () => void
  /**
   * 修改单句配音配置（传 `null` 恢复跟随整体音色）：选定音色时仅重配该句（实际音色未变且已有配音时仅更新配置），
   * 设为不配音时移除对应配音片段。
   */
  onLine: (caption: string, line: LineVoice | null) => void
}

/** 「原声」的显示名。 */
export const ORIGINAL_VOICE_NAME = '原声'

// 已选音色已从资料库移除或尚未加载时的兜底展示名
const LIBRARY_VOICE_NAME = '资料库音色'

const GENERATING_TEXT = '正在生成配音，请等待生成完成'

/** 存在在途配音生成任务（素材片或旁白）时返回阻断文案。 */
export const voiceBusy = ({
  generating,
  narrating,
}: Pick<VoiceControl, 'generating' | 'narrating'>) =>
  generating + narrating > 0 ? GENERATING_TEXT : undefined

/** 资料库音色的名字；查不到（被资料库移除或还没读到）时是兜底名「资料库音色」。 */
export const voiceNameOf = (id: string, library: readonly ReferenceAudio[] | undefined) =>
  library?.find((each) => each.id === id)?.title ?? LIBRARY_VOICE_NAME

/**
 * 选某个整体音色（`null` 为原声）：`blocked` 不能选的原因，`picked` 是不是正用着（AI 配音且是这个音色），
 * `pick` 选它——这种语言已有它的配音时只切回 AI 配音，否则设成整体音色并重配跟着它的句子。
 */
export const languageChoice = (voice: VoiceControl, id: string | null) => {
  const busy = voiceBusy(voice)
  const switchesOnly = voice.dubbed && id === voice.voice
  const blocked = switchesOnly ? busy : (busy ?? voice.generateBlocked)
  return {
    blocked,
    picked: voice.mode === 'dub' && voice.voice === id,
    pick: () => {
      if (blocked !== undefined) return
      if (switchesOnly) voice.onMode('dub')
      else voice.onGenerate(id)
    },
  }
}

/** 第 `caption` 句自己选过的配置；跟随整体音色时是 undefined。 */
export const ownLineVoice = (voice: VoiceControl, caption: string): LineVoice | undefined =>
  Object.hasOwn(voice.lines, caption) ? voice.lines[caption] : undefined

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
  const filter: ReferenceAudioFilter = { audioKind: 'voice', q: q.trim() }
  if (locale !== 'all') filter.locale = locale === 'none' ? ['none'] : [locale, 'none']
  for (const key of PICKER_TRAITS) {
    const values = traits[key]
    if (values !== undefined && values.length > 0) Object.assign(filter, { [key]: values })
  }
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
