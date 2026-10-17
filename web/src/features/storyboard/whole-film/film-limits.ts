import { z } from 'zod'
import {
  zMusicIn,
  zWholeFilmIn,
  zWholeFilmMusicIn,
  zWholeFilmSegmentIn,
  zWholeFilmSubtitle,
} from '@/shared/api/generated/zod.gen'

const required = (value: number | null | undefined, name: string): number => {
  if (value == null || !Number.isFinite(value))
    throw new Error(`整片请求的生成 schema 缺少${name}上限`)
  return value
}

const maxItems = (schema: z.ZodType, name: string): number =>
  required(z.toJSONSchema(schema).maxItems, name)

export const MAX_FILM_SEGMENTS = maxItems(zWholeFilmIn.shape.segments, '段数')
export const MAX_FILM_SUBTITLES = maxItems(zWholeFilmIn.shape.subtitles, '字幕条数')
export const MAX_MUSIC_GAIN_POINTS = maxItems(zWholeFilmMusicIn.shape.gain, '音量曲线点数')
export const MAX_FILM_SECONDS = required(zWholeFilmSubtitle.shape.endMs.maxValue, '时刻') / 1000
export const MAX_SUBTITLE_CHARS = required(zWholeFilmSubtitle.shape.text.maxLength, '字幕字数')
export const MAX_MUSIC_PROMPT_CHARS = required(zMusicIn.shape.prompt.maxLength, '音乐描述字数')
export const MAX_VOLUME = required(
  zWholeFilmSegmentIn.shape.volume.unwrap().unwrap().maxValue,
  '音量',
)
