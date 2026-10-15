/** 选区的媒体坐标与版本切换。播放位置随时间线变化，候选归属始终使用基底区间。 */

import type { GenerationJob } from '../storyboard.api'
import { baseRangeForClip, groupForRange, type ClipVersionGroup } from './clip-versions'
import { clipItem, selectedRange, type Clip, type Draft, type Edit, type Selection } from './draft'

/** 按当前时间线先后返回选中的实际素材，用它们拼出给模型的参考片段。 */
export const selectedClips = (draft: Draft, selection: Selection): readonly Clip[] | undefined => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return undefined
  const items = draft.slice(range.from, range.to + 1)
  return items.every((item) => item.kind === 'clip')
    ? items.map(({ sourceJobId, start, end }) => ({ sourceJobId, start, end }))
    : undefined
}

/** 同来源且媒体时间连续时返回一段，用于判断当前选用的候选；混合素材仍可组成编辑选区。 */
export const selectedSource = (draft: Draft, selection: Selection): Clip | undefined => {
  const clips = selectedClips(draft, selection)
  const first = clips?.[0]
  const last = clips?.at(-1)
  if (clips === undefined || first === undefined || last === undefined) return undefined
  if (
    clips.some(
      (clip, at) =>
        clip.sourceJobId !== first.sourceJobId || (at > 0 && clips[at - 1]?.end !== clip.start),
    )
  )
    return undefined
  return { sourceJobId: first.sourceJobId, start: first.start, end: last.end }
}

/** 将选区逐段映射到基底后合并；只有正向连续的基底区间才构成一个版本组。
 * 已编辑结果与相邻原片可以混选，时长变化不会改变它们对应的基底范围。 */
export const selectedGroup = (
  draft: Draft,
  selection: Selection,
  baseJobId: string,
  jobs: readonly GenerationJob[],
  durationOf?: (job: GenerationJob) => number | undefined,
): ClipVersionGroup | undefined => {
  const clips = selectedClips(draft, selection)
  if (clips === undefined) return undefined
  const ranges = clips.map((clip) => baseRangeForClip(clip, baseJobId, jobs, durationOf))
  const first = ranges[0]
  const last = ranges.at(-1)
  if (first === undefined || last === undefined) return undefined
  if (
    ranges.some(
      (range, at) => range === undefined || (at > 0 && ranges[at - 1]?.end !== range.start),
    )
  )
    return undefined
  const range = { start: first.start, end: last.end }
  return (
    groupForRange(range, baseJobId, jobs) ?? {
      key: `${baseJobId}@${Math.round(range.start * 1000)}-${Math.round(range.end * 1000)}`,
      baseJobId,
      ...range,
      edits: [],
    }
  )
}

/** 只替换当前选区，其余片段的版本、顺序与裁剪保持不动。 */
export const chooseClipVersion = (
  draft: Draft,
  selection: Selection,
  source: Clip,
): Edit | undefined => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return undefined
  const clip = clipItem(source)
  return {
    draft: [...draft.slice(0, range.from), clip, ...draft.slice(range.to + 1)],
    selection: [clip.id],
  }
}
