/** 测试预览的开与删，合同见 contract/conventions.md §19「测试预览」。预览 id 之后当对话 id 用在 transcript 与发消息上。 */

import { apiFetch } from '@/shared/api/client'
import {
  zDeletePreviewAgentsAgentIdPreviewsPreviewIdDeleteResponse,
  zOpenPreviewAgentsAgentIdPreviewsPostResponse,
} from '@/shared/api/generated/zod.gen'

const previewsPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/previews`

/** 开一段测试预览：`versionId` 为 null 试草稿（每次运行按那一刻的草稿装配），给了试那一版。交回预览 id。 */
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

/** 删掉自己的一段测试预览，删了就再也打不开。 */
export const deletePreview = async (agentId: string, previewId: string): Promise<void> => {
  await apiFetch(
    `${previewsPath(agentId)}/${encodeURIComponent(previewId)}`,
    zDeletePreviewAgentsAgentIdPreviewsPreviewIdDeleteResponse,
    { fallbackErrorMessage: '测试对话清空失败，请重试', method: 'DELETE' },
  )
}
