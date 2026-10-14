/** AI 改段的卡里预填什么：选中的段换算到原作时钟上，取与之重叠的镜头正文，正文里的 `@ImageN` 换成参考图。
 *
 * 原作的镜头存在它的请求里（`historyShotOf`），时间是原作时钟上的秒。V2 及以后的版本是合成，段的出处
 * 要按合成请求里的片段列表一层层推回原作；落在编辑段（AI 改出来的）上的部分对应不到镜头。纯函数。 */

import { z } from 'zod'
import { zComposeSegmentIn } from '@/shared/api/generated/zod.gen'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { readyAttachment, type ComposerPart } from '@/shared/ui/composer'
import { mediaDisplayName } from '@/shared/ui/media-preview'
import type { Shot } from '../shot-document'
import type { GenerationJob } from '../storyboard.api'
import { roundToMs, type Clip } from './draft'
import { isComposite } from './edit-chain'
import type { SecondsRange } from './reference-clip'

/** 合成请求里落库的片段列表：各段出处与它自己媒体时间里的起止，`end` 为空表示取到那条的结尾。 */
const zCompositeSegments = z.array(zComposeSegmentIn)
const zReferenceImageUrls = z.array(z.string())

const IMAGE_MARK = /@Image(\d+)/g

/** 记录 `jobId` 媒体时间里的 `range` 对应原作时钟上的哪几截。`seen` 是这条推导路径上已经走过的合成，
 * 记录坏了成环时停下。 */
const toRoot = (
  jobId: string,
  range: SecondsRange,
  rootId: string,
  jobs: readonly GenerationJob[],
  seen: ReadonlySet<string>,
): SecondsRange[] => {
  if (jobId === rootId) return [range]
  if (seen.has(jobId)) return []
  const job = jobs.find((candidate) => candidate.id === jobId)
  if (job === undefined || !isComposite(job)) return []
  const segments = zCompositeSegments.safeParse(job.request?.['segments'])
  if (!segments.success) return []
  const path = new Set(seen).add(jobId)
  const ranges: SecondsRange[] = []
  // 合成按片段顺序首尾相接；开放结尾的那段长度不知道，它之后的段在合成里的位置也就推不出来。
  let at = 0
  for (const segment of segments.data) {
    if (at >= range.end) break
    const length = segment.end == null ? Infinity : segment.end - segment.start
    const start = Math.max(range.start, at)
    const end = Math.min(range.end, at + length)
    if (start < end)
      ranges.push(
        ...toRoot(
          segment.sourceJobId,
          {
            start: roundToMs(segment.start + start - at),
            end: roundToMs(segment.start + end - at),
          },
          rootId,
          jobs,
          path,
        ),
      )
    at += length
  }
  return ranges
}

/** 这几段在原作时钟上的区间。合成记录从 `jobs`（编辑链查询拿回的）里找，找不到的、编辑段上的都丢掉。 */
export const rootRangesOf = (
  clips: readonly Clip[],
  rootId: string,
  jobs: readonly GenerationJob[],
): SecondsRange[] =>
  clips.flatMap((clip) =>
    toRoot(clip.sourceJobId, { start: clip.start, end: clip.end }, rootId, jobs, new Set()),
  )

/** 与这些区间有重叠（只碰端点不算）的镜头正文，按镜头时间先后、一镜一行；没有就是 `undefined`。 */
export const shotPromptOf = (
  shot: Shot['prompt'],
  ranges: readonly SecondsRange[],
): string | undefined => {
  const prompts = shot.timeline
    .filter(({ timestamps: [shotStart, shotEnd] }) =>
      ranges.some((range) => shotStart < range.end && shotEnd > range.start),
    )
    .sort((left, right) => left.timestamps[0] - right.timestamps[0])
    .map((item) => item.prompt.trim())
    .filter((prompt) => prompt !== '')
  return prompts.length === 0 ? undefined : prompts.join('\n')
}

/** 出片请求里的参考图，`@ImageN` 指第 N 张；没有就是空表。 */
export const referenceImageUrlsOf = (job: GenerationJob): string[] => {
  const parsed = zReferenceImageUrls.safeParse(job.request?.['reference_image_urls'])
  return parsed.success ? parsed.data : []
}

/** 正文装进输入框：`@ImageN` 换成那张参考图的就绪附件，编号越界的照原文留着。 */
export const promptPartsOf = (
  text: string,
  referenceImageUrls: readonly string[],
): ComposerPart[] => {
  const parts: ComposerPart[] = []
  const pushText = (value: string) => {
    if (value !== '') parts.push({ kind: 'text', text: value })
  }
  let at = 0
  for (const match of text.matchAll(IMAGE_MARK)) {
    const url = referenceImageUrls[Number(match[1]) - 1]
    if (url === undefined) continue
    pushText(text.slice(at, match.index))
    parts.push({
      kind: 'media',
      media: readyAttachment({
        kind: 'image',
        name: mediaDisplayName({ kind: 'image', name: fileNameOfUrl(url) }),
        url,
      }),
    })
    at = match.index + match[0].length
  }
  pushText(text.slice(at))
  return parts
}
