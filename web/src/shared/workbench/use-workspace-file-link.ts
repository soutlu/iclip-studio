/** 对话里点一个文件名，在工作台打开它：登记成产物的文件（如分镜）进自己的面板，其余进「文件」页的阅读视图。 */

import { useNavigate } from '@tanstack/react-router'
import { baseName } from '@/shared/lib/file-kind'
import { WORKSPACE_ARTIFACT_ID } from './artifact'
import { ARTIFACT_SEARCH_KEY, WORKSPACE_FILE_SEARCH_KEY } from './artifact-search'
import { useWorkbenchOpenRequest } from './use-workbench-open-request'
import { useWorkbenchRegistry } from './use-workbench-registry'

type WorkspaceFileLink = {
  /** 给人看的名字：登记过的文件用产物标题（分镜），其余用文件名。 */
  nameOf: (path: string) => string
  /** 在工作台打开；折叠着的工作台一并展开。 */
  open: (path: string) => void
}

/** path 须是规范化后的工作区键（见 workspacePathOf）。 */
export const useWorkspaceFileLink = (): WorkspaceFileLink => {
  const registry = useWorkbenchRegistry()
  const navigate = useNavigate()
  const { requestOpen } = useWorkbenchOpenRequest()
  // 匹配只看路径，版本号只是凑齐类型。
  const own = (path: string) => registry.matchFiles([{ path, version: 0 }])[0]
  return {
    nameOf: (path) => own(path)?.title ?? baseName(path),
    open: (path) => {
      requestOpen()
      const artifact = own(path)
      void navigate({
        search: (previous: Record<string, unknown>) =>
          artifact === undefined
            ? {
                ...previous,
                [ARTIFACT_SEARCH_KEY]: WORKSPACE_ARTIFACT_ID,
                [WORKSPACE_FILE_SEARCH_KEY]: path,
              }
            : { ...previous, [ARTIFACT_SEARCH_KEY]: artifact.id },
        to: '.',
      })
    },
  }
}
