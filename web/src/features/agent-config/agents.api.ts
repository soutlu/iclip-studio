import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import type { AgentCreateIn, AgentUpdateIn } from '@/shared/api/generated/types.gen'
import {
  type zAgentConfig,
  zAgentDetailOut,
  type zAgentOut,
  type zAgentPluginOut,
  zAgentPluginsOut,
  type zAgentProblemOut,
  zAgentPublishProblemsOut,
  zAgentsOut,
  zAgentVersionDetailOut,
  zAgentVersionOut,
  zAgentVersionsOut,
  zModelOptionsOut,
  type zSkillOut,
  zSkillsOut,
} from '@/shared/api/generated/zod.gen'

export type Agent = z.infer<typeof zAgentOut>
export type AgentDetail = z.infer<typeof zAgentDetailOut>
export type AgentConfig = z.infer<typeof zAgentConfig>
export type AgentPlugin = z.infer<typeof zAgentPluginOut>
export type AgentProblem = z.infer<typeof zAgentProblemOut>
export type AgentVersion = z.infer<typeof zAgentVersionOut>
export type ProviderOption = z.infer<typeof zModelOptionsOut>['providers'][number]
export type Skill = z.infer<typeof zSkillOut>

const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`

export const agentQueryKeys = {
  all: ['agents'] as const,
  list: ['agents', 'list'] as const,
  detail: (id: string) => ['agents', 'detail', id] as const,
  versions: (id: string) => ['agents', 'versions', id] as const,
  version: (id: string, versionId: string) => ['agents', 'version', id, versionId] as const,
  plugins: ['agents', 'plugins'] as const,
  modelOptions: ['agents', 'model-options'] as const,
  skills: ['skills', 'list'] as const,
}

export const useAgents = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/agents', zAgentsOut, { fallbackErrorMessage: '读取 Agent 列表失败', signal }),
    queryKey: agentQueryKeys.list,
    select: (data) => data.items,
  })

export const useAgent = (id: string | null) =>
  useQuery({
    enabled: id !== null,
    queryFn: ({ signal }) =>
      apiFetch(agentPath(id ?? ''), zAgentDetailOut, {
        fallbackErrorMessage: '读取 Agent 失败',
        signal,
      }),
    queryKey: agentQueryKeys.detail(id ?? ''),
  })

export const useAgentVersions = (id: string | null) =>
  useQuery({
    enabled: id !== null,
    queryFn: ({ signal }) =>
      apiFetch(`${agentPath(id ?? '')}/versions`, zAgentVersionsOut, {
        fallbackErrorMessage: '读取版本失败',
        signal,
      }),
    queryKey: agentQueryKeys.versions(id ?? ''),
    select: (data) => data.items,
  })

export const useAgentVersion = (id: string, versionId: string | null) =>
  useQuery({
    enabled: versionId !== null,
    queryFn: ({ signal }) =>
      apiFetch(
        `${agentPath(id)}/versions/${encodeURIComponent(versionId ?? '')}`,
        zAgentVersionDetailOut,
        { fallbackErrorMessage: '读取版本失败', signal },
      ),
    queryKey: agentQueryKeys.version(id, versionId ?? ''),
    staleTime: Infinity,
  })

export const useAgentPlugins = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/agents/plugins', zAgentPluginsOut, {
        fallbackErrorMessage: '读取插件失败',
        signal,
      }),
    queryKey: agentQueryKeys.plugins,
    select: (data) => data.items,
  })

export const useModelOptions = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/agents/model-options', zModelOptionsOut, {
        fallbackErrorMessage: '读取可选模型失败',
        signal,
      }),
    queryKey: agentQueryKeys.modelOptions,
    select: (data) => data.providers,
  })

export const useSkills = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/skills', zSkillsOut, { fallbackErrorMessage: '读取技能失败', signal }),
    queryKey: agentQueryKeys.skills,
    select: (data) => data.items,
  })

const useStoreDetail = () => {
  const queryClient = useQueryClient()
  return (detail: AgentDetail) => {
    queryClient.setQueryData(agentQueryKeys.detail(detail.id), detail)
    return queryClient.invalidateQueries({ queryKey: agentQueryKeys.list })
  }
}

export const useCreateAgent = () => {
  const store = useStoreDetail()
  return useMutation({
    mutationFn: (body: AgentCreateIn) =>
      apiFetch('/agents', zAgentDetailOut, {
        body,
        fallbackErrorMessage: '创建失败',
        method: 'POST',
      }),
    onSuccess: store,
  })
}

export const useUpdateAgent = () => {
  const store = useStoreDetail()
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: AgentUpdateIn }) =>
      apiFetch(agentPath(id), zAgentDetailOut, {
        body: changes,
        fallbackErrorMessage: '保存失败',
        method: 'PATCH',
      }),
    onSuccess: store,
  })
}

export const useSaveDraft = () => {
  const store = useStoreDetail()
  return useMutation({
    mutationFn: ({
      id,
      draft,
    }: {
      id: string
      draft: { config: AgentConfig; skillIds: string[]; lockVersion: number }
    }) =>
      apiFetch(`${agentPath(id)}/draft`, zAgentDetailOut, {
        body: draft,
        fallbackErrorMessage: '保存草稿失败',
        method: 'PUT',
      }),
    onSuccess: store,
  })
}

export const usePublishAgent = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, lockVersion }: { id: string; lockVersion: number }) =>
      apiFetch(`${agentPath(id)}/versions`, zAgentVersionOut, {
        body: { lockVersion },
        fallbackErrorMessage: '发布失败',
        method: 'POST',
      }),
    onSuccess: (_version, { id }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.detail(id) }),
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.versions(id) }),
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.list }),
      ]),
  })
}

export const useRestoreVersion = () => {
  const store = useStoreDetail()
  return useMutation({
    mutationFn: ({
      id,
      lockVersion,
      versionId,
    }: {
      id: string
      lockVersion: number
      versionId: string
    }) =>
      apiFetch(
        `${agentPath(id)}/versions/${encodeURIComponent(versionId)}/restore`,
        zAgentDetailOut,
        { body: { lockVersion }, fallbackErrorMessage: '恢复失败', method: 'POST' },
      ),
    onSuccess: store,
  })
}

export const publishProblemsOf = (error: unknown): AgentProblem[] | null => {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  const parsed = zAgentPublishProblemsOut.safeParse(error.body)
  return parsed.success && parsed.data.problems.length > 0 ? parsed.data.problems : null
}

export const isStaleDraft = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409
