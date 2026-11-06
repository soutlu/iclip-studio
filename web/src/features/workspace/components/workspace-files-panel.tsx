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
