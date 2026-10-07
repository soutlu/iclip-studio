/** 镜头组可选择的内容；内容身份独立于它引用的图片。 */
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

/** 内容身份：全局设定、第 n 镜，或未被任何正文引用的图片。 */
export type ShotContentRef =
  { kind: 'global' } | { kind: 'scene'; scene: number } | { kind: 'unreferenced' }

const SCENE_ID = /^scene:([1-9]\d*)$/

/** 查询参数与 DOM key 用的字符串形式。 */
export const encodeContentId = (ref: ShotContentRef): string =>
  ref.kind === 'scene' ? `scene:${ref.scene}` : ref.kind

/** 解析字符串形式；不合法返回 undefined。 */
export const decodeContentId = (id: string): ShotContentRef | undefined => {
  if (id === 'global' || id === 'unreferenced') return { kind: id }
  const match = SCENE_ID.exec(id)
  return match ? { kind: 'scene', scene: Number(match[1]) } : undefined
}

/** 路由查询参数里的内容 id。 */
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

/** 查询参数指的内容与帧：内容指不到落回首项，帧不属于该内容落回它的首帧，内容没有帧时为 undefined。 */
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

/** 导航、选区与可访问名里的短名：镜头按序号叫「镜头 N」，全局设定与未引用用标题。 */
export const contentLabel = (content: ShotContent): string =>
  content.timelineIndex === undefined ? content.title : `镜头 ${content.timelineIndex + 1}`

/** 文案列里排出来的段：全局设定与各镜头。未引用的图没有正文，不成段。 */
export const scriptSegments = (contents: readonly ShotContent[]): ShotContent[] =>
  contents.filter((item) => item.kind !== 'unreferenced')

/** 界面上的时间点与时长：取到 0.1s、固定一位小数加 s，如 0.0s、1.6s、15.0s。
 * 发给模型的提示词另用 `formatSeconds`，两套写法互不影响。 */
export const formatTimecode = (seconds: number): string =>
  `${(Math.round(seconds * 10) / 10).toFixed(1)}s`

/** 一个镜头在时间线上的起止秒与时长。 */
export type SegmentTime = { start: number; end: number; duration: number }

/** 镜头段的起止秒与时长：起止照文件取，时长由止减起后取到 0.1s，去掉浮点尾差（3.4 − 1.6 得 1.8，
 * 不是 1.7999…）。全局设定没有时间，返回 undefined。 */
export const segmentTimeRange = (shot: Shot, content: ShotContent): SegmentTime | undefined => {
  if (content.timelineIndex === undefined) return undefined
  const timestamps = shot.prompt.timeline[content.timelineIndex]?.timestamps
  if (timestamps === undefined) return undefined
  const [start, end] = timestamps
  return { duration: Math.round((end - start) * 10) / 10, end, start }
}

/** 完整区间「1.6s – 3.4s」，给时长胶囊的提示与可访问名。 */
export const formatTimeRange = (time: SegmentTime): string =>
  `${formatTimecode(time.start)} – ${formatTimecode(time.end)}`

/** 整组时间线的总长：最后一镜的止秒，与镜头条的比例、末尾的结束刻度同一口径；不取出片参数 `seconds`。 */
export const timelineDuration = (shot: Shot): number =>
  shot.prompt.timeline.reduce((end, item) => Math.max(end, item.timestamps[1]), 0)

/** 正文按显示算的字数：空白不计，@ImageN 按显示出来的 @N 计。 */
export const promptLength = (prompt: string): number =>
  Array.from(prompt.replace(/@Image(\d+)/g, '@$1').replace(/\s/g, '')).length

/** 在这段引用的帧里往前（-1）或往后（1）走一格；到头、或当前帧不属于这段时为 undefined。 */
export const adjacentFrame = (
  content: ShotContent,
  frame: number | undefined,
  step: -1 | 1,
): number | undefined => {
  const at = frame === undefined ? -1 : content.frameNumbers.indexOf(frame)
  return at < 0 ? undefined : content.frameNumbers[at + step]
}

/** 当前帧在这段引用的帧里排第几（从 1 起）、这段共几帧；这段没有帧或当前帧不属于这段时为 undefined。 */
export const framePosition = (
  content: ShotContent,
  frame: number | undefined,
): { index: number; count: number } | undefined => {
  const at = frame === undefined ? -1 : content.frameNumbers.indexOf(frame)
  return at < 0 ? undefined : { count: content.frameNumbers.length, index: at + 1 }
}

/** 一帧被哪些段用着，如「镜头 1、镜头 2 共用」「全局设定」；没有段引用时是「未引用」。 */
export const frameUsage = (contents: readonly ShotContent[], frame: number): string => {
  const users = scriptSegments(contents).filter((item) => item.frameNumbers.includes(frame))
  if (users.length === 0) return '未引用'
  const labels = users.map(contentLabel).join('、')
  return users.length > 1 ? `${labels} 共用` : labels
}

/** 在本组全部图片里点了某一帧之后选中哪段：当前段引用它就留在当前段，否则到第一个引用它的段；
 * 没有段引用时落到「未引用」，只换画面、不高亮任何段。帧不在本组时返回 undefined。 */
export const contentAfterPickingFrame = (
  contents: readonly ShotContent[],
  currentId: string,
  frame: number,
): string | undefined => {
  const current = contents.find((item) => item.id === currentId)
  if (current?.frameNumbers.includes(frame) === true) return current.id
  // 「未引用」正好收着没人引用的帧，按顺序找就会在段都不引用时落到它。
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

/** 在指定正文插入图片引用；已有编号保持不变。 */
export const insertContentReference = (
  shot: Shot,
  id: string,
  number: number,
  insertion?: PromptInsertion,
): Shot => {
  const content = shotContents(shot).find((item) => item.id === id)
  if (content?.prompt === undefined) throw new UserFacingError('请先选择全局设定或镜头')
  if (!Number.isInteger(number) || number < 1 || number > shot.image_urls.length)
    throw new UserFacingError('这张图片已不存在，请重新选择')
  return updateContentPrompt(shot, id, insertReferenceText(content.prompt, number, insertion))
}

/** 新图与正文引用在同一次草稿更新中落下；达到上限仍可关联已有图片。 */
export const appendContentImage = (
  shot: Shot,
  id: string,
  url: string,
  insertion?: PromptInsertion,
): Shot => {
  if (shot.image_urls.length >= MAX_REFERENCE_IMAGES)
    throw new UserFacingError(REFERENCE_LIMIT_TEXT)
  if (url.trim() === '') throw new UserFacingError('图片地址不能为空')
  const image_urls = [...shot.image_urls, url]
  return insertContentReference({ ...shot, image_urls }, id, image_urls.length, insertion)
}
