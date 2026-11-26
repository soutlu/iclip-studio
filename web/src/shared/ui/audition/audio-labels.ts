import {
  AUDIO_FILTER_VALUES,
  type AudioFilterKey,
  type AudioFilterValue,
  type AudioKind,
  type ReferenceAudio,
} from '@/shared/api/reference-audios'

/** 参考音频子类的中文名。 */
export const AUDIO_KIND_LABELS: Readonly<Record<AudioKind, string>> = {
  voice: '音色',
  bgm: '配乐',
  sfx: '音效',
}

/** 各项属性的中文名，及每个取值的显示名（语种的 `none` 即没设语种的音色，统一叫「多语种」）。 */
export const AUDIO_FILTER_LABELS: {
  readonly [K in AudioFilterKey]: {
    readonly name: string
    readonly values: Readonly<Record<AudioFilterValue<K>, string>>
  }
} = {
  locale: {
    name: '语种',
    values: {
      zh: '中文',
      en: 'English',
      de: 'Deutsch',
      es: 'Español',
      fr: 'Français',
      none: '多语种',
    },
  },
  gender: { name: '性别', values: { male: '男声', female: '女声', neutral: '中性' } },
  age: { name: '年龄', values: { young: '青年', middle: '中年', senior: '长者' } },
  scenario: {
    name: '场景',
    values: {
      commercials: '商业广告',
      social: '社媒种草',
      documentaries: '纪录片',
      explainers: '产品解说',
      tutorials: '教程引导',
      trailers: '电影预告',
      characters: '角色演绎',
      wellness: '身心疗愈',
    },
  },
  mood: {
    name: '情绪',
    values: { warm: '温暖', relaxed: '松弛', uplifting: '励志', epic: '史诗', suspense: '悬疑' },
  },
  genre: {
    name: '曲风',
    values: {
      acoustic: '原声吉他',
      piano: '极简钢琴',
      electronic: '电子律动',
      orchestral: '管弦',
    },
  },
  tempo: { name: '节奏', values: { slow: '慢速', medium: '中速', fast: '快速' } },
  sfxCategory: {
    name: '分类',
    values: {
      transition: '转场',
      ui: '界面提示',
      impact: '冲击重音',
      ambience: '环境音',
      foley: '拟音',
    },
  },
}

/** 节奏各档的 BPM 范围。 */
export const TEMPO_RANGES: Readonly<Record<AudioFilterValue<'tempo'>, string>> = {
  slow: '<90 BPM',
  medium: '90–120 BPM',
  fast: '>120 BPM',
}

/** 某项属性的全部选项（按接口的先后）：取值、显示名，节奏另带 BPM 范围。 */
export const audioFilterOptions = (key: AudioFilterKey) => {
  const labels: Readonly<Record<string, string>> = AUDIO_FILTER_LABELS[key].values
  const ranges: Readonly<Record<string, string>> = key === 'tempo' ? TEMPO_RANGES : {}
  return AUDIO_FILTER_VALUES[key].map((value) => ({
    id: value,
    label: labels[value] ?? value,
    description: ranges[value],
  }))
}

/** 音色的语种名：没设语种的是「多语种」。 */
export const localeLabel = (locale: ReferenceAudio['locale']) =>
  AUDIO_FILTER_LABELS.locale.values[locale ?? 'none']

/** 音色的声线：「男声 · 青年」，没填的那项不写；都没填是 null。 */
export const voiceToneText = ({ gender, age }: Pick<ReferenceAudio, 'gender' | 'age'>) =>
  joinOrNull([
    gender === null ? null : AUDIO_FILTER_LABELS.gender.values[gender],
    age === null ? null : AUDIO_FILTER_LABELS.age.values[age],
  ])

/** 适用场景：「纪录片 · 电影预告」；没填是 null。 */
export const scenariosText = ({ scenarios }: Pick<ReferenceAudio, 'scenarios'>) =>
  joinOrNull(scenarios.map((each) => AUDIO_FILTER_LABELS.scenario.values[each]))

/** 配乐的风格与情绪：「原声吉他 · 温暖」；没填是 null。 */
export const bgmStyleText = ({ genre, mood }: Pick<ReferenceAudio, 'genre' | 'mood'>) =>
  joinOrNull([
    genre === null ? null : AUDIO_FILTER_LABELS.genre.values[genre],
    mood === null ? null : AUDIO_FILTER_LABELS.mood.values[mood],
  ])

/** 音效分类名；没填是 null。 */
export const sfxCategoryText = ({ sfxCategory }: Pick<ReferenceAudio, 'sfxCategory'>) =>
  sfxCategory === null ? null : AUDIO_FILTER_LABELS.sfxCategory.values[sfxCategory]

/** 配乐节奏：「96 BPM」；没填是 null。 */
export const bpmText = ({ bpm }: Pick<ReferenceAudio, 'bpm'>) =>
  bpm === null ? null : `${String(bpm)} BPM`

/** 一条音频的属性摘要（试听条标题下那一行）：按子类列出填了的属性。 */
export const audioTraitsText = (audio: ReferenceAudio): string => {
  const parts =
    audio.audioKind === 'voice'
      ? [localeLabel(audio.locale), voiceToneText(audio), scenariosText(audio)]
      : audio.audioKind === 'bgm'
        ? [bgmStyleText(audio), bpmText(audio)]
        : [sfxCategoryText(audio)]
  return parts.filter((part) => part !== null).join(' · ')
}

/** 时长：四舍五入到秒、至少 1 秒，「1:04」。 */
export const audioDurationText = (ms: number) => clockText(Math.max(1, Math.round(ms / 1000)))

/** 已放到的时刻：按整秒往下取，「0:01」。 */
export const audioClockText = (ms: number) => clockText(Math.floor(Math.max(0, ms) / 1000))

const clockText = (seconds: number) =>
  `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`

const joinOrNull = (parts: readonly (string | null)[]) => {
  const shown = parts.filter((part) => part !== null)
  return shown.length === 0 ? null : shown.join(' · ')
}
