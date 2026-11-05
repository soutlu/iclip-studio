import type { z } from 'zod'
import type { GenerationOut } from '@/shared/api/generated/types.gen'
import { zGenerationOut } from '@/shared/api/generated/zod.gen'

type GenerationStatus = GenerationOut['status']

type GenerationRecord = z.infer<typeof zGenerationOut>

export const SHOTS_PATH = 'video_shot.json'

export const MAX_REFERENCE_IMAGES = 30

export const REFERENCE_LIMIT_TEXT = `每组最多使用 ${MAX_REFERENCE_IMAGES} 张参考图`

export type GenerationPhase = 'queued' | 'running' | 'completed' | 'failed'

export const phaseOfStatus = (status: GenerationStatus): GenerationPhase => {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'submitting':
    case 'submitted':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
  }
}

const IN_FLIGHT: ReadonlySet<GenerationStatus> = new Set(
  zGenerationOut.shape.status.options.filter((status) => {
    const phase = phaseOfStatus(status)
    return phase === 'queued' || phase === 'running'
  }),
)

export const isRunningStatus = (status: GenerationStatus): boolean => IN_FLIGHT.has(status)

export const isTake = (
  job: Pick<GenerationRecord, 'kind' | 'operation' | 'sourceJobId'>,
): boolean => job.kind === 'video' && job.operation === 'generate' && job.sourceJobId == null

export const isShotVideo = (
  job: Pick<GenerationRecord, 'kind' | 'operation' | 'shotIndex' | 'sourceJobId'>,
  shotIndex: number,
): boolean => isTake(job) && job.shotIndex === shotIndex
