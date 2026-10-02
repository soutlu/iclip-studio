/**
 * 工作区路径：工具卡上的路径是模型给的原始参数，服务端读写前按 normalize_path 规范化
 * （server/src/iclip/platform/file_store/store.py）。这里照同一套规则把它换成工作区里的键，
 * 换不出来的（目录、非法路径）就不是一份能打开的文件。
 */

const CONTROL_CHAR = /\p{Cc}/u

/** 规范化成工作区文件键；不是合法的文件路径返回 undefined。 */
export const workspacePathOf = (raw: string): string | undefined => {
  let value = raw.normalize('NFC')
  if (CONTROL_CHAR.test(value) || value.includes('\\')) return undefined
  value = value.replace(/\/{2,}/g, '/').replace(/^\//, '')
  if (value === '' || value.endsWith('/')) return undefined
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return undefined
  return value
}
