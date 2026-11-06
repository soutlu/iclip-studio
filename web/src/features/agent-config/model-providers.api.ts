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
  ModelTestIn,
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
const modelPath = (providerId: string, type: ModelType, name: string) =>
  `${providerPath(providerId)}/models/${type}/${name.split('/').map(encodeURIComponent).join('/')}`

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

export const useUpdateProvider = () =>
  useModelWrite(({ id, changes }: { id: string; changes: ModelProviderUpdateIn }) =>
    apiFetch(providerPath(id), zModelProviderOut, {
      body: changes,
      fallbackErrorMessage: '保存供应商失败',
      method: 'PATCH',
    }),
  )

export const useDeleteProvider = () =>
  useModelWrite((id: string) =>
    apiFetch(providerPath(id), z.undefined(), {
      fallbackErrorMessage: '删除供应商失败',
      method: 'DELETE',
    }),
  )

export const testCredential = (providerId: string, body: CredentialTestIn) =>
  apiFetch(`${providerPath(providerId)}/credentials/test`, zProbeOut, {
    body,
    fallbackErrorMessage: '试连失败，请重试',
    method: 'POST',
  })

export const testModel = (providerId: string, body: ModelTestIn) =>
  apiFetch(`${providerPath(providerId)}/models/test`, zProbeOut, {
    body,
    fallbackErrorMessage: '没法测试',
    method: 'POST',
  })

export const useCreateCredential = () =>
  useModelWrite(({ providerId, body }: { providerId: string; body: CredentialCreateIn }) =>
    apiFetch(`${providerPath(providerId)}/credentials`, zCredentialOut, {
      body,
      fallbackErrorMessage: '保存密钥失败',
      method: 'POST',
    }),
  )

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
