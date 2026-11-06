const CONTROL_CHAR = /\p{Cc}/u

export const workspacePathOf = (raw: string): string | undefined => {
  let value = raw.normalize('NFC')
  if (CONTROL_CHAR.test(value) || value.includes('\\')) return undefined
  value = value.replace(/\/{2,}/g, '/').replace(/^\//, '')
  if (value === '' || value.endsWith('/')) return undefined
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return undefined
  return value
}
