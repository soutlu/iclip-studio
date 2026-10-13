/** 编辑链的投影：一条出片名下的编辑段与合成 → 各版本、每一版的编辑段与在跑的合成。
 * 纯函数，不持有状态；只看记录上的来源、状态与时刻，不解析合成请求里的片段。 */

import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

/** 一版成片：原作，或链上一次完成的合成。草稿、分段与编辑段都按版分。 */
export type ChainVersion = {
  /** 这一版自己的记录 id。AI 改与合成都以它为基底。 */
  jobId: string
  /** V1、V2……按完成时刻编。 */
  label: string
  mediaUrl: string
  /** 基于哪一版；原作没有。来源可以分叉，V3 也可以基于 V1。 */
  sourceJobId: string | undefined
}

/** 编辑段：基于一版成片调模型改一段。来源与区间由服务端定、一定成对出现。 */
export type EditSegment = GenerationJob & {
  sourceJobId: string
  rangeStartMs: number
  rangeEndMs: number
}

export const isEditSegment = (job: GenerationJob): job is EditSegment =>
  job.kind === 'video' &&
  job.operation === 'generate' &&
  job.sourceJobId != null &&
  job.rangeStartMs != null &&
  job.rangeEndMs != null

/** 合成：在基底那一版上按片段列表拼成新的一版，来源是基底。 */
export const isComposite = (job: GenerationJob): job is GenerationJob & { sourceJobId: string } =>
  job.operation === 'compose' && job.sourceJobId != null

const byCreation = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)

/** 成片按到终态的时刻排；缺了这个时刻就退回创建时刻。 */
const byFinish = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.finishedAt ?? left.createdAt) - Date.parse(right.finishedAt ?? right.createdAt) ||
  left.id.localeCompare(right.id)

/** 各版本：原作是 V1，链上完成的合成（任何形状）按完成时刻接着编。`jobs` 是链查询拿回来的
 * （这条出片名下的编辑段与合成），原作自己不在里面，单独传；原作没出片就没有版本。 */
export const projectVersions = (
  root: GenerationJob,
  jobs: readonly GenerationJob[],
): ChainVersion[] => {
  if (root.outputUrl === null) return []
  const composites = jobs
    .filter(
      (job): job is GenerationJob & { sourceJobId: string; outputUrl: string } =>
        isComposite(job) && job.status === 'completed' && job.outputUrl !== null,
    )
    .sort(byFinish)
  return [
    { jobId: root.id, label: 'V1', mediaUrl: root.outputUrl, sourceJobId: undefined },
    ...composites.map((job, at) => ({
      jobId: job.id,
      label: `V${at + 2}`,
      mediaUrl: job.outputUrl,
      sourceJobId: job.sourceJobId,
    })),
  ]
}

/** 基于这一版的编辑段，不论状态，按提交先后。 */
export const editsOf = (jobs: readonly GenerationJob[], versionJobId: string): EditSegment[] =>
  jobs
    .filter((job): job is EditSegment => isEditSegment(job) && job.sourceJobId === versionJobId)
    .sort(byCreation)

/** 这一版正在跑的合成，最近提交的那条；没有就是 `undefined`。 */
export const composingOf = (
  jobs: readonly GenerationJob[],
  versionJobId: string,
): GenerationJob | undefined =>
  jobs
    .filter(
      (job) => isComposite(job) && job.sourceJobId === versionJobId && isRunningStatus(job.status),
    )
    .sort(byCreation)
    .at(-1)

/** 草稿丢了按服务端重建时还算数的编辑段：这一版最近一次完成的合成之后提交的。在那之前提交的
 * 已经拼进那次合成或被放弃了，合成完成时草稿清掉，重建时也不再放回来。 */
export const rebuildCandidates = (
  jobs: readonly GenerationJob[],
  versionJobId: string,
): EditSegment[] => {
  const lastComposite = jobs
    .filter(
      (job) => isComposite(job) && job.sourceJobId === versionJobId && job.status === 'completed',
    )
    .sort(byCreation)
    .at(-1)
  return editsOf(jobs, versionJobId).filter(
    (edit) => lastComposite === undefined || byCreation(edit, lastComposite) > 0,
  )
}

/** 每条根被成功编辑过几次，给成片卡显示：数它名下已完成的编辑段。合成只是拼接，不另算。 */
export const editCountsByRoot = (jobs: readonly GenerationJob[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    if (!isEditSegment(job) || job.status !== 'completed' || job.rootJobId === null) continue
    counts.set(job.rootJobId, (counts.get(job.rootJobId) ?? 0) + 1)
  }
  return counts
}
