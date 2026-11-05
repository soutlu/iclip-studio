import { apiFetch } from '@/shared/api/client'
import { zOpenPreviewAgentsAgentIdPreviewsPostResponse } from '@/shared/api/generated/zod.gen'

const previewsPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/previews`

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
