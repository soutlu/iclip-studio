import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect, useEffectEvent } from 'react'
import { z } from 'zod'
import { useUser } from '@/shared/auth'
import { zVideoEnhanceIn } from '@/shared/api/generated/zod.gen'
import { useMediaDownload } from '@/shared/api/media-download'
import { recordVideoDownloaded } from '@/shared/api/tracking'
import {
  enhanceNoticeId,
  readGeneration,
  useSubmitVideoEnhancement,
  videoEnhancementsKeys,
  videoEnhancementsQuery,
} from '@/shared/api/video-enhancements'
import { markEnhancementsSeen } from '@/shared/api/video-enhancements-seen'
import type { SessionUpdate } from '@/shared/transcript/connection'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { toast } from '@/shared/ui/toast'

const NOTICE_MS = 8000

const enhanceRequestSchema = z.object({ resolution: zVideoEnhanceIn.shape.resolution })

/** 提示里怎么称呼来源：有镜号叫第 N 组，没有就叫视频。 */
const sourceLabel = (job: { shotIndex?: number | null | undefined }): string => {
  if (job.shotIndex !== null && job.shotIndex !== undefined) return `第 ${job.shotIndex} 组`
  return '视频'
}

/**
 * 高清版的全局跟进：超分记录的状态跳转帧到了或重连后，失效全部高清版查询，各处下载按钮跟着刷新；
 * 自己提的那一条做好或没做成时，在哪个页面都弹一条提示，带「下载」或「重试」。
 * 治理者也收得到别人的帧，只对属主是自己的弹；应用关着时错过的不补弹。
 */
export function EnhanceNotices() {
  const connection = use(TranscriptConnectionContext)
  const queryClient = useQueryClient()
  const { data: user } = useUser()
  const submit = useSubmitVideoEnhancement()
  const { download } = useMediaDownload()

  const announce = async (jobId: string) => {
    const job = await readGeneration(jobId)
    const sourceJobId = job.sourceJobId
    if (sourceJobId === null || sourceJobId === undefined) throw new Error('超分记录没有来源')
    const { resolution } = enhanceRequestSchema.parse(job.request)
    const id = enhanceNoticeId(sourceJobId, resolution)
    const label = sourceLabel(job)
    // 点了提示条（sonner 点 action 不触发 onDismiss，所以在 action 里另记）或手动关掉都算看过；
    // 8 秒自己收起走 onAutoClose，不算。
    const seen = () => markEnhancementsSeen([job.id])
    if (job.status === 'completed' && job.outputUrl !== null) {
      const { downloadedJobIds } = await queryClient.fetchQuery(videoEnhancementsQuery(sourceJobId))
      const outputUrl = job.outputUrl
      toast(`${label}的高清版 ${resolution} 已生成`, {
        action: {
          label: '下载',
          onClick: () => {
            seen()
            for (const downloaded of downloadedJobIds) recordVideoDownloaded(downloaded)
            void download(outputUrl, `生成的视频（高清版 ${resolution}）`)
          },
        },
        duration: NOTICE_MS,
        id,
        onDismiss: seen,
      })
    } else if (job.status === 'failed') {
      toast.error(`${label}的高清版 ${resolution} 生成失败，请重试`, {
        action: {
          label: '重试',
          onClick: () => {
            seen()
            submit.mutate({ resolution, sourceJobId })
          },
        },
        duration: NOTICE_MS,
        id,
        onDismiss: seen,
      })
    }
  }

  const onUpdate = useEffectEvent((update: SessionUpdate) => {
    // 全局帧不补发：重连后同样重拉，补上断线期间的跳转。
    if (update.kind === 'reconnected') {
      void queryClient.invalidateQueries({ queryKey: videoEnhancementsKeys.all })
      return
    }
    if (update.kind !== 'generation' || update.operation !== 'enhance') return
    void queryClient.invalidateQueries({ queryKey: videoEnhancementsKeys.all })
    const settled = update.status === 'completed' || update.status === 'failed'
    if (!settled || user === null || user === undefined || update.mark.ownerUserId !== user.id)
      return
    announce(update.jobId).catch((error: unknown) => {
      console.warn('高清版提示没弹出', { error, jobId: update.jobId })
    })
  })

  useEffect(() => connection?.watchSessions((update) => onUpdate(update)), [connection])

  return null
}
