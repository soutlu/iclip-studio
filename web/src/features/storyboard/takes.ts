/** 成片区的规则：从本对话的视频记录里挑出这一组的出片、按提交时间排好、读出卡上画的几样，以及卡片尺寸。 */

import { aspectOf } from '@/shared/lib/aspect-ratio'
import type { Shot } from './shot-document'
import { isShotVideo, phaseOfStatus } from './shots'
import { historyShotOf, type GenerationJob } from './storyboard.api'
import { editCountsByRoot } from './video-editor/edit-chain'

/** 卡片的三种状态：排队与上游在跑都算在途。 */
export type TakeState = 'running' | 'completed' | 'failed'

export type Take = {
  job: GenerationJob
  state: TakeState
  /** 卡片画幅：这次出片请求的画幅，请求里没有就用分镜的。 */
  aspect: { w: number; h: number }
  /** 请求里的分辨率档位原样；没记就是 undefined，不显示。 */
  resolution: string | undefined
  /** 上游实测的片长；没回来就是 undefined，不拿请求秒数去猜。 */
  durationSeconds: number | undefined
  /** 这条出片被成功编辑过几次。 */
  editCount: number
  /** 请求用的模型 id；缺失或空白视为没记。 */
  model: string | undefined
  /** 可回填到当前组的结构化镜头组；接口调用方只写了正文的记录没有。 */
  history: Shot['prompt'] | undefined
  /** 可播放的产物地址：只有成功且地址不空才有，编辑也只在它上面切。 */
  outputUrl: string | undefined
  /** 失败时服务端的原话。 */
  error: string | undefined
}

/** request 是不透明 JSON；只读字串字段，空白算没有。 */
const requestText = (job: GenerationJob, key: string): string | undefined => {
  const value = job.request?.[key]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

const stateOf = (job: GenerationJob): TakeState => {
  const phase = phaseOfStatus(job.status)
  return phase === 'queued' || phase === 'running' ? 'running' : phase
}

/** 这一组的出片（编辑段、合成、图片与别的组都不算），按提交时间从新到旧；
 * `aspectRatio` 是分镜的画幅，请求里没记画幅的卡按它画。 */
export const takesOfShot = (
  jobs: readonly GenerationJob[],
  shotIndex: number,
  aspectRatio: string,
): Take[] => {
  const editCounts = editCountsByRoot(jobs)
  return jobs
    .filter((job) => isShotVideo(job, shotIndex))
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((job) => {
      const state = stateOf(job)
      const outputUrl = job.outputUrl?.trim()
      return {
        aspect: aspectOf(requestText(job, 'aspect_ratio') ?? aspectRatio),
        durationSeconds: job.durationMs === null ? undefined : job.durationMs / 1000,
        editCount: editCounts.get(job.id) ?? 0,
        error: state === 'failed' ? (job.errorMessage ?? undefined) : undefined,
        history: historyShotOf(job),
        job,
        model: requestText(job, 'model'),
        outputUrl: state === 'completed' && outputUrl ? outputUrl : undefined,
        resolution: requestText(job, 'resolution'),
        state,
      }
    })
}

/** 成片区的行高。 */
export const TAKE_ROW_HEIGHT = 176

/** 横屏卡最多占可见宽度的这么多，免得一张就占满、看不出还能往后滑。 */
const LANDSCAPE_MAX_SHARE = 0.48

/** 卡片尺寸：高是行高，宽按画幅算；横屏卡宽超过可见宽度的 48% 时等比缩小（同一行按底边对齐）。
 * 可见宽度还没量出来（0）时不封顶。 */
export const takeCardSize = (
  aspect: { w: number; h: number },
  visibleWidth: number,
): { width: number; height: number } => {
  const width = (TAKE_ROW_HEIGHT * aspect.w) / aspect.h
  const cap = aspect.w > aspect.h && visibleWidth > 0 ? visibleWidth * LANDSCAPE_MAX_SHARE : width
  if (width <= cap) return { height: TAKE_ROW_HEIGHT, width: Math.round(width) }
  return { height: Math.round((cap * aspect.h) / aspect.w), width: Math.round(cap) }
}
