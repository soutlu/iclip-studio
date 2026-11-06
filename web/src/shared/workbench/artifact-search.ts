import { useNavigate, useSearch } from '@tanstack/react-router'

export const ARTIFACT_SEARCH_KEY = 'artifact'

export const WORKSPACE_FILE_SEARCH_KEY = 'file'

type ArtifactSearch = { [ARTIFACT_SEARCH_KEY]?: string }

export const useArtifactSearch = (): string | undefined => {
  const search: ArtifactSearch = useSearch({ strict: false })
  return search[ARTIFACT_SEARCH_KEY]
}

export const useOpenArtifact = () => {
  const navigate = useNavigate()
  return (artifactId: string) =>
    navigate({
      search: (previous) => ({ ...previous, [ARTIFACT_SEARCH_KEY]: artifactId }),
      to: '.',
    })
}
