/** 文件页只有两个画面：列表与阅读。正在看的文件路径放查询参数 file，刷新与分享都保留。 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { errorMessageOf } from '@/shared/api/client'
import {
  useWorkspaceFiles,
  WORKSPACE_FILE_SEARCH_KEY,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import { FileList } from './file-list'
import { FileReader } from './file-reader'

export function WorkspaceFilesPanel({ conversationId }: ArtifactRendererProps) {
  const files = useWorkspaceFiles(conversationId)
  const search: { [WORKSPACE_FILE_SEARCH_KEY]?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const show = (path: string | undefined) =>
    void navigate({
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        [WORKSPACE_FILE_SEARCH_KEY]: path,
      }),
      to: '.',
    })

  if (search[WORKSPACE_FILE_SEARCH_KEY] !== undefined) {
    return (
      <FileReader
        conversationId={conversationId}
        onBack={() => show(undefined)}
        path={search[WORKSPACE_FILE_SEARCH_KEY]}
      />
    )
  }
  return (
    <FileList
      error={files.isError ? errorMessageOf(files.error, '读取工作区文件失败') : undefined}
      files={files.data?.files}
      onOpen={show}
      pending={files.isPending}
    />
  )
}
