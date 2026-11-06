import { queryOptions, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationVideoProgressOut } from '@/shared/api/generated/zod.gen'
import { conversationsQueryKeys } from './conversations.api'

export type VideoProgress = z.output<typeof zConversationVideoProgressOut>['conversations']

export type VideoPhase = VideoProgress[string] | 'none'

const videoProgressSchema = zConversationVideoProgressOut.transform(
  (payload) => payload.conversations,
)

const videoProgressQuery = queryOptions({
  queryFn: ({ signal }) =>
    apiFetch('/conversations/video-progress', videoProgressSchema, {
      cache: 'no-store',
      fallbackErrorMessage: '读取视频进度失败',
      signal,
    }),
  queryKey: conversationsQueryKeys.videoProgress,
})

export const videoPhaseOf = (
  progress: VideoProgress | undefined,
  conversationId: string,
): VideoPhase => progress?.[conversationId] ?? 'none'

export const useVideoProgress = (refetchInterval: () => number | false = () => false) =>
  useQuery({ ...videoProgressQuery, refetchInterval })

export const useVideoPhase = (conversationId: string): VideoPhase =>
  useQuery({
    ...videoProgressQuery,
    select: (progress) => videoPhaseOf(progress, conversationId),
  }).data ?? 'none'
