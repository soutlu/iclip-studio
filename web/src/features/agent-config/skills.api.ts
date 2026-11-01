/** 技能库的读写：技能详情、草稿文件、改显示名、新建与发布。合同见 contract/conventions.md §17。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type { SkillCreateIn } from '@/shared/api/generated/types.gen'
import { zDraftFileOut, zSkillDetailOut, zSkillVersionOut } from '@/shared/api/generated/zod.gen'
import { agentQueryKeys } from './agents.api'

export type SkillDetail = z.infer<typeof zSkillDetailOut>
export type DraftFile = z.infer<typeof zDraftFileOut>

const skillPath = (id: string) => `/skills/${encodeURIComponent(id)}`
// 文件路径里的斜杠原样带上（合同 §17「文件」），只转义每一段。
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

/** 草稿里一个文件的内容与 hash；`enabled` 为假时不读（还没保存的新文件）。 */
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

/** 写操作后技能列表上的显示名、说明、版本与未发布标记随之重读。 */
export const useRefreshSkill = () => {
  const queryClient = useQueryClient()
  return (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: skillQueryKeys.detail(id) }),
      queryClient.invalidateQueries({ queryKey: agentQueryKeys.skills }),
    ])
}

/** 新建技能，同时生成带 frontmatter 的 `SKILL.md` 草稿；标识被占用是 409，不合规矩是 422。 */
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

/** 改显示名；不进版本，立即生效。 */
export const updateSkillDisplayName = (id: string, displayName: string) =>
  apiFetch(skillPath(id), zSkillDetailOut, {
    body: { displayName },
    fallbackErrorMessage: '保存技能名称失败',
    method: 'PATCH',
  })

/** 写一个草稿文件：新建时 `baseHash` 为 null，改已有文件时给读到的 hash，对不上是 409。 */
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

/** 改名一次写完，内容与 hash 不变；答复新路径上的文件。 */
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

/** 把服务端此刻的草稿发布成新版本；草稿不合格、或与最新版相同是 422，`detail` 列出全部问题。 */
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
