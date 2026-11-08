export const sanitizeCueAuthNextPath = (nextPath: string | null | undefined) => {
  const trimmedPath = nextPath?.trim() ?? ''

  if (!trimmedPath.startsWith('/') || trimmedPath.startsWith('//')) {
    return '/'
  }

  return trimmedPath
}
