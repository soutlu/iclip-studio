import { z } from 'zod'
import { UserFacingError } from '@/shared/api/client'
import { MAX_REFERENCE_IMAGES, REFERENCE_LIMIT_TEXT } from './shots'
import {
  extractImageIndexes,
  promptTitle,
  updateTimelinePrompt,
  insertReferenceText,
  type PromptInsertion,
  type Shot,
} from './shot-document'

export type ShotContentRef =
  { kind: 'global' } | { kind: 'scene'; scene: number } | { kind: 'unreferenced' }

const SCENE_ID = /^scene:([1-9]\d*)$/

export const encodeContentId = (ref: ShotContentRef): string =>
  ref.kind === 'scene' ? `scene:${ref.scene}` : ref.kind

export const decodeContentId = (id: string): ShotContentRef | undefined => {
  if (id === 'global' || id === 'unreferenced') return { kind: id }
  const match = SCENE_ID.exec(id)
  return match ? { kind: 'scene', scene: Number(match[1]) } : undefined
}

export const shotContentIdSchema = z
  .string()
  .refine((id) => decodeContentId(id) !== undefined, '内容 id 不合法')

export type ShotContent = {
  id: string
  kind: ShotContentRef['kind']
  title: string
  frameNumbers: number[]
  prompt?: string
  timelineIndex?: number
}

export const shotContents = (shot: Shot): [ShotContent, ...ShotContent[]] => {
  const valid = (numbers: number[]) => numbers.filter((n) => n >= 1 && n <= shot.image_urls.length)
  const contents: [ShotContent, ...ShotContent[]] = [
    {
      id: encodeContentId({ kind: 'global' }),
      kind: 'global',
      title: '全局设定',
      prompt: shot.prompt.global_settings,
      frameNumbers: valid(extractImageIndexes(shot.prompt.global_settings)),
    },
    ...shot.prompt.timeline.map((item, index) => ({
      id: encodeContentId({ kind: 'scene', scene: index + 1 }),
      kind: 'scene' as const,
      title: promptTitle(item.prompt) ?? `镜头 ${index + 1}`,
      prompt: item.prompt,
      timelineIndex: index,
      frameNumbers: valid(item.image_indexes),
    })),
  ]
  const used = new Set(contents.flatMap((item) => item.frameNumbers))
  const unused = shot.image_urls.flatMap((_, index) => (used.has(index + 1) ? [] : [index + 1]))
  if (unused.length > 0)
    contents.push({
      id: encodeContentId({ kind: 'unreferenced' }),
      kind: 'unreferenced',
      title: '未引用',
      frameNumbers: unused,
    })
  return contents
}

export const resolveShotSelection = (
  contents: readonly [ShotContent, ...ShotContent[]],
  wanted: { content: string | undefined; frame: number | undefined },
): { content: ShotContent; frame: number | undefined } => {
  const content = contents.find((item) => item.id === wanted.content) ?? contents[0]
  const frame =
    wanted.frame !== undefined && content.frameNumbers.includes(wanted.frame)
      ? wanted.frame
      : content.frameNumbers[0]
  return { content, frame }
}

export const contentLabel = (content: ShotContent): string =>
  content.timelineIndex === undefined ? content.title : `镜头 ${content.timelineIndex + 1}`

export const scriptSegments = (contents: readonly ShotContent[]): ShotContent[] =>
  contents.filter((item) => item.kind !== 'unreferenced')

export const formatTimecode = (seconds: number): string =>
  `${(Math.round(seconds * 10) / 10).toFixed(1)}s`

export type SegmentTime = { start: number; end: number; duration: number }

export const segmentTimeRange = (shot: Shot, content: ShotContent): SegmentTime | undefined => {
  if (content.timelineIndex === undefined) return undefined
  const timestamps = shot.prompt.timeline[content.timelineIndex]?.timestamps
  if (timestamps === undefined) return undefined
  const [start, end] = timestamps
  return { duration: Math.round((end - start) * 10) / 10, end, start }
}

export const formatTimeRange = (time: SegmentTime): string =>
  `${formatTimecode(time.start)} – ${formatTimecode(time.end)}`

export const timelineDuration = (shot: Shot): number =>
  shot.prompt.timeline.reduce((end, item) => Math.max(end, item.timestamps[1]), 0)

export const promptLength = (prompt: string): number =>
  Array.from(prompt.replace(/@Image(\d+)/g, '@$1').replace(/\s/g, '')).length

export const adjacentFrame = (
  content: ShotContent,
  frame: number | undefined,
  step: -1 | 1,
): number | undefined => {
  const at = frame === undefined ? -1 : content.frameNumbers.indexOf(frame)
  return at < 0 ? undefined : content.frameNumbers[at + step]
}

export const framePosition = (
  content: ShotContent,
  frame: number | undefined,
): { index: number; count: number } | undefined => {
  const at = frame === undefined ? -1 : content.frameNumbers.indexOf(frame)
  return at < 0 ? undefined : { count: content.frameNumbers.length, index: at + 1 }
}

export const frameUsage = (contents: readonly ShotContent[], frame: number): string => {
  const users = scriptSegments(contents).filter((item) => item.frameNumbers.includes(frame))
  if (users.length === 0) return '未引用'
  const labels = users.map(contentLabel).join('、')
  return users.length > 1 ? `${labels} 共用` : labels
}

export const contentAfterPickingFrame = (
  contents: readonly ShotContent[],
  currentId: string,
  frame: number,
): string | undefined => {
  const current = contents.find((item) => item.id === currentId)
  if (current?.frameNumbers.includes(frame) === true) return current.id
  return contents.find((item) => item.frameNumbers.includes(frame))?.id
}

export const updateContentPrompt = (shot: Shot, id: string, text: string): Shot => {
  const content = shotContents(shot).find((item) => item.id === id)
  if (content?.kind === 'global')
    return { ...shot, prompt: { ...shot.prompt, global_settings: text } }
  if (content?.timelineIndex !== undefined)
    return updateTimelinePrompt(shot, content.timelineIndex, text)
  throw new UserFacingError('请先选择全局设定或镜头')
}

export const insertContentReference = (
  shot: Shot,
  id: string,
  number: number,
  insertion?: PromptInsertion,
): Shot => {
  const content = shotContents(shot).find((item) => item.id === id)
  if (content?.prompt === undefined) throw new UserFacingError('请先选择全局设定或镜头')
  if (!Number.isInteger(number) || number < 1 || number > shot.image_urls.length)
    throw new UserFacingError('该图片已不存在，请重新选择')
  return updateContentPrompt(shot, id, insertReferenceText(content.prompt, number, insertion))
}

export const appendContentImage = (
  shot: Shot,
  id: string,
  url: string,
  insertion?: PromptInsertion,
): Shot => {
  if (shot.image_urls.length >= MAX_REFERENCE_IMAGES)
    throw new UserFacingError(REFERENCE_LIMIT_TEXT)
  if (url.trim() === '') throw new UserFacingError('图片地址为空，无法添加')
  const image_urls = [...shot.image_urls, url]
  return insertContentReference({ ...shot, image_urls }, id, image_urls.length, insertion)
}
