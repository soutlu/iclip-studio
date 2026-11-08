import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type { SkillCreateIn, SkillUpdateIn } from '@/shared/api/generated/types.gen'
import { zDraftFileOut, zSkillDetailOut, zSkillVersionOut } from '@/shared/api/generated/zod.gen'
import { agentQueryKeys } from './agents.api'

export type SkillDetail = z.infer<typeof zSkillDetailOut>
export type DraftFile = z.infer<typeof zDraftFileOut>

const skillPath = (id: string) => `/skills/${encodeURIComponent(id)}`
const filePath = (id: string, path: string) =>
  `${skillPath(id)}/draft/files/${path.split('/').map(encodeURIComponent).join('/')}`

export const skillQueryKeys = {
  detail: (id: string) => ['skills', 'detail', id] as const,
  file: (id: string, path: string) => ['skills', 'file', id, path] as const,
}

export const useSkillDetail = (id: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(skillPath(id), zSkillDetailOut, { fallbackErrorMessage: '读取技能失败', signal }),
    queryKey: skillQueryKeys.detail(id),
  })

export const useSkillFile = (id: string, path: string, enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) =>
      apiFetch(filePath(id, path), zDraftFileOut, {
        fallbackErrorMessage: '读取文件失败',
        signal,
      }),
    queryKey: skillQueryKeys.file(id, path),
  })

export const useRefreshSkill = () => {
  const queryClient = useQueryClient()
  return (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: skillQueryKeys.detail(id) }),
      queryClient.invalidateQueries({ queryKey: agentQueryKeys.skills }),
    ])
}

export const useCreateSkill = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SkillCreateIn) =>
      apiFetch('/skills', zSkillDetailOut, {
        body,
        fallbackErrorMessage: '创建失败',
        method: 'POST',
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(skillQueryKeys.detail(detail.id), detail)
      return queryClient.invalidateQueries({ queryKey: agentQueryKeys.skills })
    },
  })
}

export const updateSkill = (id: string, body: SkillUpdateIn) =>
  apiFetch(skillPath(id), zSkillDetailOut, {
    body,
    fallbackErrorMessage: '保存技能失败',
    method: 'PATCH',
  })

export const writeSkillFile = (
  id: string,
  path: string,
  content: string,
  baseHash: string | null,
) =>
  apiFetch(filePath(id, path), zDraftFileOut, {
    body: { baseHash, content },
    fallbackErrorMessage: `保存 ${path} 失败`,
    method: 'PUT',
  })

export const renameSkillFile = (id: string, from: string, to: string, baseHash: string) =>
  apiFetch(`${skillPath(id)}/draft/files/rename`, zDraftFileOut, {
    body: { baseHash, from, to },
    fallbackErrorMessage: '重命名失败',
    method: 'POST',
  })

export const deleteSkillFile = (id: string, path: string, baseHash: string) =>
  apiFetch(`${filePath(id, path)}?${new URLSearchParams({ baseHash }).toString()}`, z.undefined(), {
    fallbackErrorMessage: '删除失败',
    method: 'DELETE',
  })

export const usePublishSkill = () => {
  const refresh = useRefreshSkill()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`${skillPath(id)}/versions`, zSkillVersionOut, {
        body: {},
        fallbackErrorMessage: '发布失败',
        method: 'POST',
      }),
    onSuccess: (_version, id) => refresh(id),
  })
}
