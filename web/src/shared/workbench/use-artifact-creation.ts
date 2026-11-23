import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { toast } from '@/shared/ui/toast'
import type { Artifact, CreatableEntry } from './artifact'
import { useOpenArtifact } from './artifact-search'
import { useWorkbenchOpenRequest } from './use-workbench-open-request'
import { useWorkbenchRegistry } from './use-workbench-registry'
import { workspaceQueryKeys } from './workspace.api'

type ArtifactCreationOptions = {
  conversationId: string
  artifacts: readonly Artifact[]
  /** 工作区文件列表是否已完成首次加载：首次加载完成前不将任何产物判定为新增。 */
  filesLoaded: boolean
  readOnly: boolean
}

/**
 * 管理工作台内可新建产物的创建流程与新增检测（见 `ArtifactEntry.create`）：
 * - `creatable`：当前可新建的类型列表（非只读对话且尚未存在该产物）；
 * - `create(entry)`：创建完成后刷新工作区文件并切换至对应页签（工作台收起时自动展开）；失败时提示「<label> 新建失败」及服务端原因；
 * - `creating`：当前正在创建中的产物类型；
 * - `arrived(id)`：判断产物是否在打开对话后新增（由本页或 Agent 创建），用于触发页签入场动效。
 * 对话打开期间若该类产物由 Agent 从无到有创建，则自动切换至其页签并弹出提示；打开对话时已存在的产物不触发。
 */
export const useArtifactCreation = ({
  conversationId,
  artifacts,
  filesLoaded,
  readOnly,
}: ArtifactCreationOptions) => {
  const registry = useWorkbenchRegistry()
  const queryClient = useQueryClient()
  const openArtifact = useOpenArtifact()
  const { requestOpen } = useWorkbenchOpenRequest()
  // 记录本页发起创建、尚未在文件列表中观察到的产物类型，避免将其误判为 Agent 创建。
  // 须在发起请求前登记：文件变更推送触发的列表刷新可能早于创建接口响应到达。
  const ownRef = useRef(new Set<string>())
  // 上一次文件列表中已观测到的可新建产物 ID 集合；null 表示尚未完成首次加载。
  const seenRef = useRef<ReadonlySet<string> | null>(null)

  const mutation = useMutation({
    mutationFn: async (entry: CreatableEntry) => {
      ownRef.current.add(entry.type)
      try {
        const path = await entry.create.run(conversationId, queryClient)
        await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.files(conversationId) })
        return path
      } catch (error) {
        ownRef.current.delete(entry.type)
        throw error
      }
    },
    onError: (error, entry) => {
      toast.error(errorMessageOf(error, `${entry.label} 新建失败`))
    },
    onSuccess: (path) => {
      const owner = registry.ownerOf(path)
      if (owner === undefined) return
      requestOpen()
      void openArtifact(owner.id)
    },
  })

  const present = artifacts.filter((artifact) => registry.resolve(artifact.type)?.create)
  const presentKey = present.map((artifact) => artifact.id).join('\n')
  // 首次加载文件列表时已存在的产物 ID 集合；此后新增的均视为新到达
  const [initialIds, setInitialIds] = useState<ReadonlySet<string> | null>(null)
  if (filesLoaded && initialIds === null) {
    setInitialIds(new Set(present.map((artifact) => artifact.id)))
  }
  const onArrived = useEffectEvent((ids: readonly string[]) => {
    for (const artifact of present.filter(({ id }) => ids.includes(id))) {
      if (ownRef.current.delete(artifact.type)) continue
      void openArtifact(artifact.id)
      const notice = registry.resolve(artifact.type)?.create?.agentCreatedNotice
      if (notice !== undefined) toast(notice)
    }
  })
  useEffect(() => {
    if (!filesLoaded) return
    const ids = presentKey === '' ? [] : presentKey.split('\n')
    const previous = seenRef.current
    seenRef.current = new Set(ids)
    if (previous === null) return
    const arrived = ids.filter((id) => !previous.has(id))
    if (arrived.length > 0) onArrived(arrived)
  }, [filesLoaded, presentKey])

  const creatable = readOnly
    ? []
    : registry
        .creatable()
        .filter((entry) => !artifacts.some((artifact) => artifact.type === entry.type))
  return {
    arrived: (id: string) =>
      initialIds !== null && !initialIds.has(id) && present.some((artifact) => artifact.id === id),
    creatable,
    create: (entry: CreatableEntry) => {
      if (!mutation.isPending) mutation.mutate(entry)
    },
    creating: mutation.isPending ? mutation.variables.type : undefined,
  }
}
