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
  /** 工作区文件列表读到了没有：读到第一份之前谁都不算「新出现」。 */
  filesLoaded: boolean
  readOnly: boolean
}

/**
 * 工作台里新建产物（见 `ArtifactEntry.create`）：
 * - `creatable`：现在能新建的类型——对话不是只读、这类产物还没有；
 * - `create(entry)`：建好后刷新工作区文件、直接切到它的页签（工作台收着时展开）；失败时提示
 *   「<label> 新建失败」和服务端给的原因；
 * - `creating`：正在建的类型；
 * - `arrived(id)`：这件产物是不是打开对话以后才出现的（本页建的或 agent 建的），页签出现时按它播一下动画。
 * 对话开着时这类产物从无到有、又不是本页建的（agent 建的），切到它的页签并提示；刚打开对话时已有的不算。
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
  // 本页在建、建好后还没在文件列表里出现过的类型：它们出现时不当成 agent 建的。
  // 建之前就记下：工作区通知触发的那次刷新可能比新建的答复先到
  const ownRef = useRef(new Set<string>())
  // 上一次文件列表里有的这类产物；null 是还没读到过列表
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
  // 第一次读到文件列表时已有的这类产物：之后出现的都算新出现
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
