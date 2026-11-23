import { z } from 'zod'
import { aspectOf } from '@/shared/lib/aspect-ratio'
import { byFinish, isComposite } from './editing/version-lineage'
import type { Shot } from './shot-document'
import { isShotVideo, phaseOfStatus } from './shots'
import { historyShotOf, type GenerationJob } from './storyboard.api'
import { DRAFT_LABEL } from './video-generation-options'
import { editCountsByRoot } from './video-editor/edit-chain'

export type TakeState = 'running' | 'completed' | 'failed'

export type Take = {
  job: GenerationJob
  shown: GenerationJob
  state: TakeState
  aspect: { w: number; h: number }
  resolution: string | undefined
  draft: boolean
  fullHd: GenerationJob | undefined
  durationSeconds: number | undefined
  editCount: number
  model: string | undefined
  history: Shot['prompt'] | undefined
  outputUrl: string | undefined
  error: string | undefined
}

const requestText = (job: GenerationJob, key: string): string | undefined => {
  const value = job.request?.[key]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

const zDraftRequest = z.object({ provider_options: z.object({ draft: z.literal(true) }) })

const isDraft = (job: GenerationJob): boolean => zDraftRequest.safeParse(job.request).success

export const qualityLabelOf = (take: Take): string | undefined =>
  take.draft ? DRAFT_LABEL : take.resolution

const stateOf = (job: GenerationJob): TakeState => {
  const phase = phaseOfStatus(job.status)
  return phase === 'queued' || phase === 'running' ? 'running' : phase
}

const latestFullHdByDraft = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const latest = new Map<string, GenerationJob>()
  for (const job of jobs
    .filter((item) => item.status !== 'failed')
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const draftId = requestText(job, 'draft_job_id')
    if (draftId !== undefined) latest.set(draftId, job)
  }
  return latest
}

const latestCompositesByRoot = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const finished = jobs
    .filter((job) => isComposite(job) && job.status === 'completed' && job.outputUrl?.trim())
    .toSorted(byFinish)
  const latest = new Map<string, GenerationJob>()
  for (const job of finished) if (job.rootJobId !== null) latest.set(job.rootJobId, job)
  return latest
}

export const takesOfShot = (
  jobs: readonly GenerationJob[],
  shotIndex: number,
  aspectRatio: string,
): Take[] => {
  const editCounts = editCountsByRoot(jobs)
  const latestComposites = latestCompositesByRoot(jobs)
  const latestFullHd = latestFullHdByDraft(jobs)
  return jobs
    .filter((job) => isShotVideo(job, shotIndex))
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((job) => {
      const state = stateOf(job)
      const shown = latestComposites.get(job.id) ?? job
      const outputUrl = shown.outputUrl?.trim()
      const draft = isDraft(job)
      return {
        aspect: aspectOf(requestText(job, 'aspect_ratio') ?? aspectRatio),
        draft,
        durationSeconds: shown.durationMs === null ? undefined : shown.durationMs / 1000,
        editCount: editCounts.get(job.id) ?? 0,
        error: state === 'failed' ? (job.errorMessage ?? undefined) : undefined,
        fullHd: draft ? latestFullHd.get(job.id) : undefined,
        history: historyShotOf(job),
        job,
        model: requestText(job, 'model'),
        outputUrl: state === 'completed' && outputUrl ? outputUrl : undefined,
        resolution: requestText(job, 'resolution'),
        shown,
        state,
      }
    })
}

export type TakeAction =
  { kind: 'hidden' } | { kind: 'enabled' } | { kind: 'blocked'; reason: string }

export type FullHdAction =
  { kind: 'hidden' } | { kind: 'convert' } | { kind: 'converting' | 'converted'; jobId: string }

export type TakeActions = {
  download: TakeAction
  editVideo: TakeAction
  refill: TakeAction
  fullHd: FullHdAction
}

const HIDDEN: TakeAction = { kind: 'hidden' }
const ENABLED: TakeAction = { kind: 'enabled' }
const blocked = (reason: string): TakeAction => ({ kind: 'blocked', reason })

const fullHdActionOf = (take: Take, readOnly: boolean): FullHdAction => {
  if (!take.draft || take.state !== 'completed') return { kind: 'hidden' }
  if (take.fullHd === undefined) return { kind: readOnly ? 'hidden' : 'convert' }
  return {
    jobId: take.fullHd.id,
    kind: stateOf(take.fullHd) === 'completed' ? 'converted' : 'converting',
  }
}

export const takeActionsOf = (
  take: Take,
  { readOnly, refillable = true }: { readOnly: boolean; refillable?: boolean },
): TakeActions => {
  const video = (verb: string): TakeAction => {
    if (take.outputUrl !== undefined) return ENABLED
    if (take.state === 'running') return HIDDEN
    return blocked(take.state === 'failed' ? `生成失败，无法${verb}视频` : '未返回视频地址')
  }
  return {
    download: video('下载'),
    editVideo: readOnly ? HIDDEN : video('编辑'),
    fullHd: fullHdActionOf(take, readOnly),
    refill:
      readOnly || !refillable
        ? HIDDEN
        : take.history === undefined
          ? blocked('该素材片未记录分镜结构，无法回填')
          : ENABLED,
  }
}

export const TAKE_ROW_HEIGHT = 176

const LANDSCAPE_MAX_SHARE = 0.48

export const takeCardSize = (
  aspect: { w: number; h: number },
  visibleWidth: number,
): { width: number; height: number } => {
  const width = (TAKE_ROW_HEIGHT * aspect.w) / aspect.h
  const cap = aspect.w > aspect.h && visibleWidth > 0 ? visibleWidth * LANDSCAPE_MAX_SHARE : width
  if (width <= cap) return { height: TAKE_ROW_HEIGHT, width: Math.round(width) }
  return { height: Math.round((cap * aspect.h) / aspect.w), width: Math.round(cap) }
}
