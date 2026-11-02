/** 开测试预览，合同见 contract/conventions.md §19「测试预览」。预览 id 之后当对话 id 用在 transcript 与发消息上。 */

import { apiFetch } from '@/shared/api/client'
import { zOpenPreviewAgentsAgentIdPreviewsPostResponse } from '@/shared/api/generated/zod.gen'

const previewsPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/previews`

/**
 * 开一段新的测试预览，换掉自己在这个 agent 上的当前预览（后端先中断它）：`versionId` 为 null 试草稿（每次运行按
 * 那一刻的草稿装配），给了试那一版。交回预览 id。
 */
export const openPreview = async (agentId: string, versionId: string | null): Promise<string> => {
  const preview = await apiFetch(
    previewsPath(agentId),
    zOpenPreviewAgentsAgentIdPreviewsPostResponse,
    {
      body: versionId === null ? {} : { versionId },
      fallbackErrorMessage: '测试对话开启失败，请重试发送',
      method: 'POST',
    },
  )
  return preview.id
}
