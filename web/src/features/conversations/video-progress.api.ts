/**
 * 视频进度（合同 §6）：看得见的对话里，哪些下面还有视频记录没跑完、各到哪一步，没列出的就是没有。
 * 它随生成任务变、不在对话行上：视频帧与重连由 useLiveConversations 让它重拉，行池不管它。
 */

import { queryOptions, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationVideoProgressOut } from '@/shared/api/generated/zod.gen'
import { conversationsQueryKeys } from './conversations.api'

export type VideoProgress = z.output<typeof zConversationVideoProgressOut>['conversations']

/** 一段对话的视频阶段；视频进度里没有它就是 none，不画角标。 */
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

/** 整份视频进度。`refetchInterval` 给需求单面板兜底轮询，其余地方不轮询。 */
export const useVideoProgress = (refetchInterval: () => number | false = () => false) =>
  useQuery({ ...videoProgressQuery, refetchInterval })

/** 一段对话的视频阶段：只在这一段变了时重渲，侧栏每行各取一份。 */
export const useVideoPhase = (conversationId: string): VideoPhase =>
  useQuery({
    ...videoProgressQuery,
    select: (progress) => videoPhaseOf(progress, conversationId),
  }).data ?? 'none'
