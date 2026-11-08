import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zRecordEventTrackingEventsPostResponse,
  type zRecordEventTrackingEventsPostBody,
} from '@/shared/api/generated/zod.gen'

type TrackingEvent = z.input<typeof zRecordEventTrackingEventsPostBody>

export const recordVideoDownloaded = (jobId: string): void => {
  const event: TrackingEvent = { jobId, name: 'video.downloaded' }
  apiFetch('/tracking/events', zRecordEventTrackingEventsPostResponse, {
    body: event,
    fallbackErrorMessage: '记录下载失败',
    keepalive: true,
    method: 'POST',
  }).catch((error: unknown) => {
    console.warn('下载埋点没记上', { error, jobId })
  })
}
