import type { AudioKind, AudioLocale, ReferenceAudio } from '@/shared/api/reference-audios'
import type { ReferenceAudioChange, ReferenceAudioDraft } from './reference-audios.api'

type Trait<K extends keyof ReferenceAudio> = NonNullable<ReferenceAudio[K]>

/** 添加 / 修改弹窗里填的内容；节奏是输入框里的字，提交时才换成数。 */
export type AudioFormValues = {
  kind: AudioKind
  title: string
  description: string
  locale: AudioLocale | null
  gender: Trait<'gender'> | null
  age: Trait<'age'> | null
  /** 按选的先后，最多 2 个。 */
  scenarios: readonly Trait<'scenarios'>[number][]
  transcript: string
  mood: Trait<'mood'> | null
  genre: Trait<'genre'> | null
  bpm: string
  sfxCategory: Trait<'sfxCategory'> | null
}

export const MAX_TITLE_CHARS = 200
export const MAX_TEXT_CHARS = 2000
export const MAX_SCENARIOS = 2
export const BPM_MIN = 20
export const BPM_MAX = 300

export const emptyAudioForm = (kind: AudioKind): AudioFormValues => ({
  kind,
  title: '',
  description: '',
  locale: null,
  gender: null,
  age: null,
  scenarios: [],
  transcript: '',
  mood: null,
  genre: null,
  bpm: '',
  sfxCategory: null,
})

export const audioFormOf = (audio: ReferenceAudio): AudioFormValues => ({
  kind: audio.audioKind,
  title: audio.title,
  description: audio.description ?? '',
  locale: audio.locale,
  gender: audio.gender,
  age: audio.age,
  scenarios: audio.scenarios,
  transcript: audio.transcript ?? '',
  mood: audio.mood,
  genre: audio.genre,
  bpm: audio.bpm === null ? '' : String(audio.bpm),
  sfxCategory: audio.sfxCategory,
})

/** 节奏：空是不填（null），不是 20～300 的整数是 undefined（填得不对）。 */
export const bpmOf = (text: string): number | null | undefined => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const bpm = Number(trimmed)
  return Number.isInteger(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX ? bpm : undefined
}

const textOrNull = (text: string) => {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/** 只属于 `kind` 的那几项属性（台词也只有音色有）；跨子类填了接口会拒。 */
const traitsOf = (values: AudioFormValues) => {
  switch (values.kind) {
    case 'voice':
      return {
        locale: values.locale,
        gender: values.gender,
        age: values.age,
        scenarios: values.scenarios,
        transcript: textOrNull(values.transcript),
      }
    case 'bgm':
      return { mood: values.mood, genre: values.genre, bpm: bpmOf(values.bpm) ?? null }
    case 'sfx':
      return { sfxCategory: values.sfxCategory }
  }
}

/** 添加时发的内容：没填的不写。 */
export const audioDraftOf = (values: AudioFormValues): ReferenceAudioDraft => {
  const draft: ReferenceAudioDraft = { audioKind: values.kind, title: values.title.trim() }
  const description = textOrNull(values.description)
  if (description !== null) draft.description = description
  for (const [key, value] of Object.entries(traitsOf(values)))
    if (value !== null && !(Array.isArray(value) && value.length === 0))
      Object.assign(draft, { [key]: value })
  return draft
}

const sameValue = (left: unknown, right: unknown) =>
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((each) => right.includes(each))
    : left === right

/** 修改时发的内容：只发改了的，清空的发 null（场景发 []）。 */
export const audioChangeOf = (
  values: AudioFormValues,
  audio: ReferenceAudio,
): ReferenceAudioChange => {
  const change: ReferenceAudioChange = {}
  const title = values.title.trim()
  if (title !== audio.title) change.title = title
  const description = textOrNull(values.description)
  if (description !== audio.description) change.description = description
  // 子类改不了，两边是同一套键
  const saved = new Map(Object.entries(traitsOf(audioFormOf(audio))))
  for (const [key, value] of Object.entries(traitsOf(values)))
    if (!sameValue(value, saved.get(key))) Object.assign(change, { [key]: value })
  return change
}
