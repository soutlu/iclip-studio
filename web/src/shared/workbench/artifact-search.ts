import { useNavigate, useSearch } from '@tanstack/react-router'

export const ARTIFACT_SEARCH_KEY = 'artifact'

export const WORKSPACE_FILE_SEARCH_KEY = 'file'

type ArtifactSearch = { [ARTIFACT_SEARCH_KEY]?: string }

export const useArtifactSearch = (): string | undefined => {
  const search: ArtifactSearch = useSearch({ strict: false })
  return search[ARTIFACT_SEARCH_KEY]
}

/** 在 URL 查询参数中选中产物 `artifactId`；传入 `undefined` 时清除参数，工作台恢复默认产物。 */
export const useOpenArtifact = () => {
  const navigate = useNavigate()
  return (artifactId: string | undefined) =>
    navigate({
      search: (previous) => ({ ...previous, [ARTIFACT_SEARCH_KEY]: artifactId }),
      to: '.',
    })
}
