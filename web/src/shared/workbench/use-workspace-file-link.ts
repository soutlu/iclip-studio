import { useNavigate } from '@tanstack/react-router'
import { WORKSPACE_ARTIFACT_ID } from './artifact'
import { ARTIFACT_SEARCH_KEY, WORKSPACE_FILE_SEARCH_KEY } from './artifact-search'
import { useWorkbenchOpenRequest } from './use-workbench-open-request'
import { useWorkbenchRegistry } from './use-workbench-registry'

type WorkspaceFileLink = {
  open: (path: string) => void
}

export const useWorkspaceFileLink = (): WorkspaceFileLink => {
  const registry = useWorkbenchRegistry()
  const navigate = useNavigate()
  const { requestOpen } = useWorkbenchOpenRequest()
  return {
    open: (path) => {
      requestOpen()
      const artifact = registry.matchFiles([{ path, version: 0 }])[0]
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
