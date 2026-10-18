import { z } from 'zod'
import { formatDateTime } from '@/shared/lib/date-time'
import type { PeaksState } from '../editing/media-analysis'
import type { GenerationJob } from '../storyboard.api'
import type { useMusicAnalysis } from './music-analysis'

const promptOf = (job: GenerationJob): string | undefined =>
  z.object({ prompt: z.string().min(1) }).safeParse(job.request).data?.prompt

/** 音乐列表中的描述：生成的用描述，上传的写明是上传的与上传时刻 */
export const musicTitleOf = (job: GenerationJob): string =>
  job.operation === 'upload'
    ? `上传的音乐 · ${formatDateTime(job.createdAt)}`
    : (promptOf(job) ?? '生成的音乐')

/** 分析结果换成波形组件要的状态 */
export const peaksStateOf = (analysis: ReturnType<typeof useMusicAnalysis>): PeaksState =>
  analysis.data !== undefined
    ? { kind: 'ready', peaks: analysis.data.peaks }
    : analysis.isError
      ? { kind: 'failed', error: analysis.error }
      : { kind: 'loading' }
