/**
 * 按语言放人声。原文永远用原声；加的每种语言有一个人声设置，记在主文件根上的 `data-voice-modes`：
 * - 保留原声（`original`）：这种语言的配音片段不出声，原声照常；
 * - AI 配音（`dub`）：这种语言的配音片段出声，原视频的声音（视频片段的原声、分离出来的原声片段）都不出声。
 * 每种语言还记着配音用的音色：参考音频库里一个音色的编号，或者从素材片的原声里取（null）。写法是
 * `{ "<语言>": { "mode": "dub" | "original", "voice": "<音色>" | null } }`；没写的语言、写法不对的语言都是保留原声、
 * 原声的音色。
 * 配音片段是带 `data-locale`、`data-dub-of` 的普通 `<audio>`（见 `film.ts` 的 `AudioDub`）。预览和按语言导出都用
 * `localizedVoices` 按这条规则改主文件。
 */
export const VOICE_MODES = 'data-voice-modes'

export type VoiceMode = 'original' | 'dub'

/** 一种语言的人声设置：出不出配音，配音用哪个音色（null 是从原声里取）。 */
export type VoiceSetting = { mode: VoiceMode; voice: string | null }

/** 各语言的人声设置；没有的语言是保留原声、原声的音色。 */
export type VoiceModes = Readonly<Record<string, VoiceSetting>>

const NO_MODES: VoiceModes = {}

const DEFAULT_SETTING: VoiceSetting = { mode: 'original', voice: null }

const settingOf = (value: unknown): VoiceSetting | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { mode, voice } = value as Record<string, unknown>
  if (mode !== 'dub' && mode !== 'original') return undefined
  if (voice !== null && (typeof voice !== 'string' || voice === '')) return undefined
  return { mode, voice }
}

/** 读 `data-voice-modes` 的值；没写或不是 JSON 对象时都是默认设置，写法不对的语言也是。 */
export function voiceModesOf(json: string | undefined): VoiceModes {
  if (json === undefined) return NO_MODES
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return NO_MODES
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_MODES
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).flatMap(([locale, value]) => {
      const setting = settingOf(value)
      return setting === undefined ? [] : [[locale, setting] as const]
    }),
  )
}

/** 语言 `locale` 的人声设置；原文（null）总是保留原声、原声的音色。 */
export const voiceSettingOf = (modes: VoiceModes, locale: string | null): VoiceSetting =>
  (locale === null || !Object.hasOwn(modes, locale) ? undefined : modes[locale]) ?? DEFAULT_SETTING

/** 语言 `locale` 出不出配音；原文（null）总是保留原声。 */
export const voiceModeOf = (modes: VoiceModes, locale: string | null): VoiceMode =>
  voiceSettingOf(modes, locale).mode

/**
 * `data-voice-modes` 改成语言 `locale` 用 `setting` 以后要写的值：默认设置（保留原声、原声的音色）不写；各语言都是
 * 默认设置时是 null（去掉这个属性）。
 */
export function voiceModesAttribute(
  modes: VoiceModes,
  locale: string,
  setting: VoiceSetting,
): string | null {
  const next = Object.fromEntries(
    Object.entries({ ...modes, [locale]: setting }).flatMap(([each, { mode, voice }]) =>
      mode === 'original' && voice === null ? [] : [[each, { mode, voice }] as const],
    ),
  )
  return Object.keys(next).length === 0 ? null : JSON.stringify(next)
}

/** 主文件根下一个元素在按语言放人声时用到的部分：小写的标签名和属性。 */
export interface VoiceElement {
  tag: string
  attributes: Readonly<Record<string, string>>
}

/** 根下第 `index` 个元素要做的改动：去掉它，或者把几个属性改成给的值（null 是去掉这个属性）。 */
export type VoiceChange =
  | { index: number; remove: true }
  | { index: number; remove: false; attributes: Readonly<Record<string, string | null>> }

const named = (value: string | undefined) => value !== undefined && value !== ''

/**
 * 按语言放人声（规则见文件头）：`elements` 是主文件根下的元素（按文件里的先后），`modes` 是根上的人声设置，
 * `locale` 是要放的语言（原文是 null）。答复要改的元素，按文件里的先后：
 * - 配音片段：别的语言的、原文下的、这种语言保留原声时的都去掉；
 * - AI 配音时：原声开着的视频片段关掉原声（照编辑器的写法加 `muted`、去掉 `data-has-audio`），分离出来的
 *   原声片段（带 `data-sync-origin` 的 `<audio>`）去掉。
 * 别的元素不动。
 */
export function localizedVoices(
  elements: readonly VoiceElement[],
  modes: VoiceModes,
  locale: string | null,
): VoiceChange[] {
  const dubbing = voiceModeOf(modes, locale) === 'dub'
  return elements.flatMap(({ tag, attributes }, index): VoiceChange[] => {
    if (tag === 'audio' && named(attributes['data-locale']) && named(attributes['data-dub-of']))
      return dubbing && attributes['data-locale'] === locale ? [] : [{ index, remove: true }]
    if (!dubbing) return []
    if (tag === 'audio' && named(attributes['data-sync-origin'])) return [{ index, remove: true }]
    if (tag === 'video' && attributes['muted'] === undefined)
      return [{ index, remove: false, attributes: { muted: 'true', 'data-has-audio': null } }]
    return []
  })
}
