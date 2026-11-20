import { useNavigate, useSearch } from '@tanstack/react-router'

export const ARTIFACT_SEARCH_KEY = 'artifact'

export const WORKSPACE_FILE_SEARCH_KEY = 'file'

type ArtifactSearch = { [ARTIFACT_SEARCH_KEY]?: string }

export const useArtifactSearch = (): string | undefined => {
  const search: ArtifactSearch = useSearch({ strict: false })
  return search[ARTIFACT_SEARCH_KEY]
}

/** 在地址里选中产物 `artifactId`；给 undefined 时去掉选中，工作台回到默认的那一个。 */
export const useOpenArtifact = () => {
  const navigate = useNavigate()
  return (artifactId: string | undefined) =>
    navigate({
      search: (previous) => ({ ...previous, [ARTIFACT_SEARCH_KEY]: artifactId }),
      to: '.',
    })
}
