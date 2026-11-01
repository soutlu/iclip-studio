/** 模型供应商、密钥、模型与默认模型的读写，都要 `model:manage`。合同见 contract/conventions.md §18。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type {
  CredentialCreateIn,
  CredentialTestIn,
  CredentialUpdateIn,
  CustomModelCreateIn,
  ModelProviderCreateIn,
  ModelProviderUpdateIn,
  ModelUpdateIn,
} from '@/shared/api/generated/types.gen'
import {
  zCredentialOut,
  zDeclarationsOut,
  zDefaultModelOut,
  zDefaultModelsOut,
  zModelProviderOut,
  zModelProvidersOut,
  zProbeOut,
  zProviderModelOut,
} from '@/shared/api/generated/zod.gen'
import { agentQueryKeys } from './agents.api'

export type ModelProvider = z.infer<typeof zModelProviderOut>
export type ProviderCredential = ModelProvider['credentials'][number]
export type ProviderModel = ModelProvider['models'][number]
export type ModelType = ProviderModel['type']
export type Declaration = z.infer<typeof zDeclarationsOut>['declarations'][number]
export type DefaultModel = z.infer<typeof zDefaultModelOut>
export type AgentUsage = ProviderModel['usedBy'][number]

/** 在用的 agent 名，用顿号连起来，写进提示与拦下的原因。 */
export const usageNames = (users: readonly AgentUsage[]): string =>
  users.map((user) => user.agentName).join('、')

const providerQueryKeys = {
  all: ['model-providers'] as const,
  list: ['model-providers', 'list'] as const,
  declarations: ['model-providers', 'declarations'] as const,
  defaults: ['model-providers', 'defaults'] as const,
}

const providerPath = (id: string) => `/model-providers/${encodeURIComponent(id)}`
const credentialPath = (providerId: string, id: string) =>
  `${providerPath(providerId)}/credentials/${encodeURIComponent(id)}`
// 模型名在路径最后、可以带斜杠（合同 §18「模型」），斜杠原样带上，只转义每一段。
const modelPath = (providerId: string, type: ModelType, name: string) =>
  `${providerPath(providerId)}/models/${type}/${name.split('/').map(encodeURIComponent).join('/')}`

/** 全部供应商，按接入时刻从新到旧；每个带密钥（只给打码值）、模型与各自的「谁在用」。 */
export const useModelProviders = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/model-providers', zModelProvidersOut, {
        fallbackErrorMessage: '读取供应商失败',
        signal,
      }),
    queryKey: providerQueryKeys.list,
    select: (data) => data.providers,
  })

/** 本部署能接入的模型声明；随代码发布，读一次就够。 */
export const useProviderDeclarations = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/model-providers/declarations', zDeclarationsOut, {
        fallbackErrorMessage: '读取模型声明失败',
        signal,
      }),
    queryKey: providerQueryKeys.declarations,
    select: (data) => data.declarations,
    staleTime: Infinity,
  })

/** 各类型的默认模型；没设的类型不在里面。 */
export const useDefaultModels = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/default-models', zDefaultModelsOut, {
        fallbackErrorMessage: '读取默认模型失败',
        signal,
      }),
    queryKey: providerQueryKeys.defaults,
    select: (data) => data.defaults,
  })

/**
 * 一次写操作：成功后重读供应商与默认模型，并让 agent 编辑页的「选模型」重读，模型设置里马上看得到改动。
 * 失败的 `ApiError` 原样抛给调用方，就地写出后端的原因（含被引用时的 409）。
 */
const useModelWrite = <Variables, Result>(request: (variables: Variables) => Promise<Result>) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: providerQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.modelOptions }),
      ]),
  })
}

export const useCreateProvider = () =>
  useModelWrite((body: ModelProviderCreateIn) =>
    apiFetch('/model-providers', zModelProviderOut, {
      body,
      fallbackErrorMessage: '添加供应商失败',
      method: 'POST',
    }),
  )

/** 改显示名、启停或默认密钥；有 agent 写着它时停用是 409。 */
export const useUpdateProvider = () =>
  useModelWrite(({ id, changes }: { id: string; changes: ModelProviderUpdateIn }) =>
    apiFetch(providerPath(id), zModelProviderOut, {
      body: changes,
      fallbackErrorMessage: '保存供应商失败',
      method: 'PATCH',
    }),
  )

/** 连同密钥与模型设置一起删；有 agent 写着它、或默认模型在它这里是 409。 */
export const useDeleteProvider = () =>
  useModelWrite((id: string) =>
    apiFetch(providerPath(id), z.undefined(), {
      fallbackErrorMessage: '删除供应商失败',
      method: 'DELETE',
    }),
  )

/** 只试不存：没通过也是 200，看 `ok` 与 `reason`。 */
export const testCredential = (providerId: string, body: CredentialTestIn) =>
  apiFetch(`${providerPath(providerId)}/credentials/test`, zProbeOut, {
    body,
    fallbackErrorMessage: '试连失败，请重试',
    method: 'POST',
  })

/** 新建密钥；后端保存前再试连一次，不通是 422。供应商的第一把自动成为默认密钥。 */
export const useCreateCredential = () =>
  useModelWrite(({ providerId, body }: { providerId: string; body: CredentialCreateIn }) =>
    apiFetch(`${providerPath(providerId)}/credentials`, zCredentialOut, {
      body,
      fallbackErrorMessage: '保存密钥失败',
      method: 'POST',
    }),
  )

/** `fields` 只放要改的字段，没给的保持原值。 */
export const useUpdateCredential = () =>
  useModelWrite(
    ({
      providerId,
      id,
      changes,
    }: {
      providerId: string
      id: string
      changes: CredentialUpdateIn
    }) =>
      apiFetch(credentialPath(providerId, id), zCredentialOut, {
        body: changes,
        fallbackErrorMessage: '保存密钥失败',
        method: 'PATCH',
      }),
  )

export const useDeleteCredential = () =>
  useModelWrite(({ providerId, id }: { providerId: string; id: string }) =>
    apiFetch(credentialPath(providerId, id), z.undefined(), {
      fallbackErrorMessage: '删除密钥失败',
      method: 'DELETE',
    }),
  )

export const useAddModel = () =>
  useModelWrite(({ providerId, body }: { providerId: string; body: CustomModelCreateIn }) =>
    apiFetch(`${providerPath(providerId)}/models`, zProviderModelOut, {
      body,
      fallbackErrorMessage: '添加模型失败',
      method: 'POST',
    }),
  )

/** 声明里的模型只能改 `enabled`；在用或是默认模型时停用是 409。 */
export const useUpdateModel = () =>
  useModelWrite(
    ({
      providerId,
      model,
      changes,
    }: {
      providerId: string
      model: ProviderModel
      changes: ModelUpdateIn
    }) =>
      apiFetch(modelPath(providerId, model.type, model.name), zProviderModelOut, {
        body: changes,
        fallbackErrorMessage: '保存模型失败',
        method: 'PATCH',
      }),
  )

export const useDeleteModel = () =>
  useModelWrite(({ providerId, model }: { providerId: string; model: ProviderModel }) =>
    apiFetch(modelPath(providerId, model.type, model.name), z.undefined(), {
      fallbackErrorMessage: '删除模型失败',
      method: 'DELETE',
    }),
  )

export const useSetDefaultModel = () =>
  useModelWrite(
    ({ type, providerId, modelName }: { type: ModelType; providerId: string; modelName: string }) =>
      apiFetch(`/default-models/${type}`, zDefaultModelOut, {
        body: { modelName, providerId },
        fallbackErrorMessage: '设置默认模型失败',
        method: 'PUT',
      }),
  )
