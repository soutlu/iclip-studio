/** 文件页只有两个画面：列表与阅读。正在看的文件路径放查询参数 file，刷新与分享都保留。 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
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

  const reading = search[WORKSPACE_FILE_SEARCH_KEY]
  // 记下最近读过的文件，回到列表时给那一行留个记号；不管是从列表点进来还是从对话里的文件名跳进来。
  const [lastOpened, setLastOpened] = useState<string>()
  if (reading !== undefined && reading !== lastOpened) setLastOpened(reading)

  if (reading !== undefined) {
    return (
      <FileReader
        conversationId={conversationId}
        key={reading}
        onBack={() => show(undefined)}
        path={reading}
      />
    )
  }
  return (
    <FileList
      error={files.isError ? errorMessageOf(files.error, '读取工作区文件失败，请重试') : undefined}
      files={files.data?.files}
      lastOpened={lastOpened}
      onOpen={show}
      pending={files.isPending}
    />
  )
}
