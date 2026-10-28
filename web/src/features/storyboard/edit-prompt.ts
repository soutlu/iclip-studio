/** 输入卡（共享输入框）里的内容与它要提交的东西之间的转换：图片编辑器存草稿、制作页按描述再生成、
 * 视频编辑器改段共用。 */

import type { ComposerPart } from '@/shared/ui/composer'
import type { AnnotationNode } from './image-edit/annotation-node'
import { MAX_PART_NAME } from './image-edit/image-edit-draft'
import type { EditDraftPart } from './image-edit/image-edit-types'

/** 正文里的一张图片：就绪的按地址认，上传中的还没有地址，按条目认。失败的不算，它提交不了。 */
type ImageSlot = { key: string; url: string | undefined }

export const imageSlotsOf = (parts: readonly ComposerPart<AnnotationNode>[]): ImageSlot[] =>
  parts.flatMap((part) =>
    part.kind === 'media' && part.media.status !== 'error'
      ? [{ key: part.media.url ?? part.media.attId, url: part.media.url }]
      : [],
  )

/** 只取就绪的部分；去掉没就绪的图片后相邻的文字并成一段。 */
export const draftPartsOf = (parts: readonly ComposerPart<AnnotationNode>[]): EditDraftPart[] => {
  const result: EditDraftPart[] = []
  const pushText = (text: string) => {
    const previous = result.at(-1)
    if (previous?.kind === 'text')
      result[result.length - 1] = { kind: 'text', text: previous.text + text }
    else result.push({ kind: 'text', text })
  }
  for (const part of parts) {
    if (part.kind === 'text') pushText(part.text)
    else if (part.kind === 'node') result.push({ kind: 'annotation', ...part.node.attrs })
    else if (part.media.status === 'ready' && part.media.url !== undefined)
      result.push({
        kind: 'image',
        name: part.media.name.slice(0, MAX_PART_NAME),
        url: part.media.url,
      })
  }
  return result
}

/** 输入卡里的描述编成发给模型的样子：参考图按第一次出现的先后排，正文里写 `@ImageN`（N 是它在
 * `referenceImageUrls` 里的位置，从 1 起），与后端拼文件里的描述、分镜正文同一种写法。标注没有对应的图，不写进正文。 */
export const compileReferencePrompt = (
  parts: readonly EditDraftPart[],
): { text: string; referenceImageUrls: string[] } => {
  const referenceImageUrls: string[] = []
  const text = parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'annotation') return ''
      if (!referenceImageUrls.includes(part.url)) referenceImageUrls.push(part.url)
      return `@Image${referenceImageUrls.indexOf(part.url) + 1}`
    })
    .join('')
  return { referenceImageUrls, text }
}

/** 网关调度：不带参考视频时 1 张图作首帧、2 张依次作首帧与尾帧，更多才作参考图（multiflow docs/api.md）。 */
export const MAX_FIRST_FRAMES = 2

/** 图生的描述：图片不超过 MAX_FIRST_FRAMES 张时网关按先后把它们当首帧、尾帧，正文里不写引用，去掉芯片后
 * 多出来的空白并成一个、行首行尾的去掉；更多张时同 compileReferencePrompt。 */
export const compileImageClipPrompt = (
  parts: readonly EditDraftPart[],
): { text: string; referenceImageUrls: string[] } => {
  const compiled = compileReferencePrompt(parts)
  if (compiled.referenceImageUrls.length > MAX_FIRST_FRAMES) return compiled
  const text = parts
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/^[^\S\n]+|[^\S\n]+$/gm, '')
  return { referenceImageUrls: compiled.referenceImageUrls, text }
}
