/**
 * 按语言放人声。原文用原声，加上原文的旁白（原文下的配音片段，见 `film.ts` 的 `AudioDub`）；加的每种语言有一个
 * 人声设置，记在主文件根上的 `data-voice-modes`：
 * - 保留原声（`original`）：和原文一样，这种语言的配音片段不出声；
 * - AI 配音（`dub`）：这种语言的配音片段出声，原视频的声音（视频片段的原声、分离出来的原声片段）和原文的旁白
 *   都不出声。
 * 每种语言还记着配音用的音色：参考音频库里一个音色的编号，或者从素材片的原声里取（null）；各句可以有自己的
 * 选择（按字幕编号记）：用某个音色（null 是原声的音色），或者不配音，没记的句子跟着这种语言的音色。写法是
 * `{ "<语言>": { "mode": "dub" | "original", "voice": "<音色>" | null,
 *   "lines": { "<字幕编号>": { "voice": "<音色>" | null } | { "dub": false } } } }`，`lines` 空着时不写；没写的语言、
 * 写法不对的语言都是保留原声、原声的音色，写法不对的句子当没选过。
 * 配音片段是带 `data-dub-of` 的普通 `<audio>`，其它语言的带 `data-locale`，旁白不带（见 `film.ts` 的 `AudioDub`）。
 * 预览和按语言导出都用 `localizedVoices` 按这条规则改主文件。
 */
export const VOICE_MODES = 'data-voice-modes'

export type VoiceMode = 'original' | 'dub'

/** 一句自己的选择：用某个音色（null 是原声的音色），或者不配音。 */
export type LineVoice = { voice: string | null } | { dub: false }

/** 各句自己的选择：字幕编号 → 选择；没有的句子跟着这种语言的音色。 */
export type LineVoices = Readonly<Record<string, LineVoice>>

/** 一种语言的人声设置：出不出配音，配音用哪个音色（null 是从原声里取），各句自己的选择。 */
export type VoiceSetting = { mode: VoiceMode; voice: string | null; lines: LineVoices }

/** 各语言的人声设置；没有的语言是保留原声、原声的音色。 */
export type VoiceModes = Readonly<Record<string, VoiceSetting>>

const NO_MODES: VoiceModes = {}

const NO_LINES: LineVoices = {}

const DEFAULT_SETTING: VoiceSetting = { mode: 'original', voice: null, lines: NO_LINES }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isVoice = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value !== '')

const lineVoiceOf = (value: unknown): LineVoice | undefined => {
  if (!isRecord(value)) return undefined
  if (value['dub'] === false) return { dub: false }
  return 'voice' in value && isVoice(value['voice']) ? { voice: value['voice'] } : undefined
}

const settingOf = (value: unknown): VoiceSetting | undefined => {
  if (!isRecord(value)) return undefined
  const { mode, voice, lines } = value
  if ((mode !== 'dub' && mode !== 'original') || !isVoice(voice)) return undefined
  const chosen = Object.entries(isRecord(lines) ? lines : {}).flatMap(([caption, each]) => {
    const line = lineVoiceOf(each)
    return line === undefined ? [] : [[caption, line] as const]
  })
  return { mode, voice, lines: chosen.length === 0 ? NO_LINES : Object.fromEntries(chosen) }
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
 * 一句在这种语言（人声设置 `setting`）下用的音色：自己选过的按它的，没选过的跟着这种语言的音色；null 是原声的
 * 音色，undefined 是不配音。
 */
export function voiceOfLine(
  setting: Pick<VoiceSetting, 'voice' | 'lines'>,
  caption: string,
): string | null | undefined {
  const own = Object.hasOwn(setting.lines, caption) ? setting.lines[caption] : undefined
  if (own === undefined) return setting.voice
  return 'voice' in own ? own.voice : undefined
}

/** 把一句的选择改成 `line`（null 是去掉它自己的选择，跟着这种语言的音色）。 */
export function withLineVoice(
  setting: VoiceSetting,
  caption: string,
  line: LineVoice | null,
): VoiceSetting {
  const others = Object.fromEntries(Object.entries(setting.lines).filter(([id]) => id !== caption))
  return { ...setting, lines: line === null ? others : { ...others, [caption]: line } }
}

/** 删掉一句字幕以后的人声设置：各语言里它的选择都去掉；哪种语言都没记着它时就是 `modes` 本身。 */
export function voiceModesWithout(modes: VoiceModes, caption: string): VoiceModes {
  if (!Object.values(modes).some(({ lines }) => Object.hasOwn(lines, caption))) return modes
  return Object.fromEntries(
    Object.entries(modes).map(([locale, setting]) => [
      locale,
      withLineVoice(setting, caption, null),
    ]),
  )
}

/**
 * `data-voice-modes` 要写的值：默认设置（保留原声、原声的音色、没有哪句自己选过）的语言不写，`lines` 空着时不写；
 * 各语言都是默认设置时是 null（去掉这个属性）。
 */
export function voiceModesAttribute(modes: VoiceModes): string | null {
  const next = Object.fromEntries(
    Object.entries(modes).flatMap(([locale, { mode, voice, lines }]) => {
      const chosen = Object.keys(lines).length > 0
      if (mode === 'original' && voice === null && !chosen) return []
      return [[locale, chosen ? { mode, voice, lines } : { mode, voice }] as const]
    }),
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
 * - 其它语言的配音片段：别的语言的、原文下的、这种语言保留原声时的都去掉；
 * - 旁白：AI 配音时去掉；
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
    if (tag === 'audio' && named(attributes['data-dub-of'])) {
      const spoken = named(attributes['data-locale'])
        ? dubbing && attributes['data-locale'] === locale
        : !dubbing
      return spoken ? [] : [{ index, remove: true }]
    }
    if (!dubbing) return []
    if (tag === 'audio' && named(attributes['data-sync-origin'])) return [{ index, remove: true }]
    if (tag === 'video' && attributes['muted'] === undefined)
      return [{ index, remove: false, attributes: { muted: 'true', 'data-has-audio': null } }]
    return []
  })
}
