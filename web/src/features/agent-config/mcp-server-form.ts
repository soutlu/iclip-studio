import type {
  McpCheckIn,
  McpHeaderIn,
  McpServerCreateIn,
  McpServerUpdateIn,
} from '@/shared/api/generated/types.gen'
import { MCP_STATUS_LABEL } from './mcp-draft'
import type { McpAuthMode, McpCheck, McpServer, McpTransport } from './mcp-servers.api'

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SCOPE_PATTERN = /^[^\s"\\]+$/

export const MAX_HEADERS = 20
export const TIMEOUT_PRESETS = [10, 30, 60, 120] as const

export type HeaderRow = {
  key: string
  name: string
  savedName: string | null
  masked: string | null
  value: string
  editing: boolean
}

export type ScopeRow = { name: string; on: boolean }

export type Values = {
  id: string
  name: string
  description: string
  url: string
  transport: McpTransport
  timeout: number
  authMode: McpAuthMode
  headers: HeaderRow[]
  /** `null`：管理员还没动过权限，按服务上保存的现状显示。 */
  scopes: ScopeRow[] | null
  clientId: string
  clientSecret: string
}

export type Errors = Partial<Record<string, string>>

/** 测试连接的结果；`fresh` 表示是这次打开面板后、改动连接设置后测的。 */
export type TestState =
  | { kind: 'none' }
  | { kind: 'testing' }
  | { kind: 'ok'; elapsedMs: number; fresh: boolean }
  | { kind: 'failed'; reason: string; fresh: boolean }

export const testOfServer = (server: McpServer | undefined): TestState => {
  const check = server?.lastCheck ?? null
  if (check === null) return { kind: 'none' }
  return check.ok
    ? { elapsedMs: check.elapsedMs, fresh: false, kind: 'ok' }
    : { fresh: false, kind: 'failed', reason: check.reason ?? MCP_STATUS_LABEL.failed }
}

export const testOfCheck = (check: McpCheck, fresh: boolean): TestState =>
  check.ok
    ? { elapsedMs: check.elapsedMs, fresh, kind: 'ok' }
    : { fresh, kind: 'failed', reason: check.reason ?? MCP_STATUS_LABEL.failed }

export const valuesOf = (server: McpServer | undefined): Values => ({
  authMode: server?.authMode ?? 'shared',
  clientId: server?.oauth.presetClient?.clientId ?? '',
  clientSecret: '',
  description: server?.description ?? '',
  headers: (server?.headers ?? []).map((header, index) => ({
    editing: false,
    key: `saved-${index}`,
    masked: header.value,
    name: header.name,
    savedName: header.name,
    value: '',
  })),
  id: server?.id ?? '',
  name: server?.name ?? '',
  scopes: null,
  timeout: server?.timeoutSeconds ?? 30,
  transport: server?.transport ?? 'streamable_http',
  url: server?.url ?? '',
})

/** 超时的可选档：四个预设，保存过的其他数值作为多出来的一档，按大小排进去。 */
export const timeoutOptions = (current: number): number[] =>
  (TIMEOUT_PRESETS as readonly number[]).includes(current)
    ? [...TIMEOUT_PRESETS]
    : [...TIMEOUT_PRESETS, current].sort((a, b) => a - b)

/** 服务公布的权限（登录用的几个除外）与管理员加过的权限，各自是否请求；服务还没公布时为 `null`。 */
export const savedScopeRows = (server: McpServer | undefined): ScopeRow[] | null => {
  const published = server?.oauth.publishedScopes ?? null
  if (server === undefined || published === null) return null
  const signIn = server.oauth.signInScopes ?? []
  const chosen = server.oauth.scopes
  const names = [...new Set([...published, ...(chosen ?? [])])].filter(
    (name) => !signIn.includes(name),
  )
  return names.map((name) => ({ name, on: chosen === null || chosen.includes(name) }))
}

export const scopeRowsOf = (values: Values, server: McpServer | undefined): ScopeRow[] | null =>
  values.scopes ?? savedScopeRows(server)

export const showsClient = (values: Values, server: McpServer | undefined): boolean =>
  values.authMode === 'per_user' &&
  server !== undefined &&
  (server.oauth.client === 'required' || server.oauth.presetClient !== null)

const keepsSavedValue = (row: HeaderRow) =>
  row.value === '' &&
  row.savedName !== null &&
  row.savedName.toLowerCase() === row.name.trim().toLowerCase()

const headersOf = (rows: readonly HeaderRow[]): McpHeaderIn[] =>
  rows.map((row) =>
    keepsSavedValue(row) ? { name: row.name.trim() } : { name: row.name.trim(), value: row.value },
  )

const isHttpUrl = (text: string): boolean => {
  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== ''
  } catch {
    return false
  }
}

export const validate = (values: Values, creating: boolean): Errors => {
  const errors: Errors = {}
  if (values.name.trim() === '') errors['name'] = '请填写服务名称'
  if (creating) {
    const id = values.id.trim()
    if (id === '') errors['id'] = '请填写标识'
    else if (!ID_PATTERN.test(id))
      errors['id'] = '标识以小写字母开头，只能用小写字母、数字和连字符，最多 40 个字符'
  }
  if (!isHttpUrl(values.url.trim())) errors['url'] = '请填写以 http:// 或 https:// 开头的完整地址'
  const seen = new Set<string>()
  for (const row of values.headers) {
    const name = row.name.trim()
    if (name === '') errors[`header-name-${row.key}`] = '请填写请求头名称'
    else if (!HEADER_NAME_PATTERN.test(name))
      errors[`header-name-${row.key}`] =
        "请求头名称只能用英文字母、数字和 ! # $ % & ' * + - . ^ _ ` | ~"
    else if (seen.has(name.toLowerCase())) errors[`header-name-${row.key}`] = '请求头名称不能重复'
    seen.add(name.toLowerCase())
    if (row.value === '' && !keepsSavedValue(row))
      errors[`header-value-${row.key}`] = '请填写请求头的值'
  }
  return errors
}

/** 新加一个权限名时的问题；没问题返回 `null`。 */
export const scopeNameProblem = (name: string, rows: readonly ScopeRow[]): string | null => {
  if (name === '') return '请填写权限名称'
  if (!SCOPE_PATTERN.test(name)) return '权限名称不能含空格、引号或反斜杠'
  if (rows.some((row) => row.name === name)) return '这个权限已在列表里'
  return null
}

const sameRows = (a: readonly ScopeRow[] | null, b: readonly ScopeRow[] | null) =>
  JSON.stringify(a) === JSON.stringify(b)

const comparable = (values: Values, server: McpServer | undefined) => ({
  authMode: values.authMode,
  clientId: values.clientId.trim(),
  clientSecret: values.clientSecret,
  description: values.description.trim(),
  headers: values.headers.map((row) => [row.name.trim(), row.value, row.savedName]),
  name: values.name.trim(),
  scopes: scopeRowsOf(values, server),
  timeout: values.timeout,
  transport: values.transport,
  url: values.url.trim(),
})

export const isDirty = (values: Values, server: McpServer | undefined): boolean =>
  JSON.stringify(comparable(values, server)) !==
  JSON.stringify(comparable(valuesOf(server), server))

/** 保存前试连一份配置（只用于共用请求头的服务）。 */
export const checkBody = (values: Values, serverId: string | null): McpCheckIn => ({
  authMode: values.authMode,
  headers: headersOf(values.headers),
  serverId,
  timeoutSeconds: values.timeout,
  transport: values.transport,
  url: values.url.trim(),
})

export const createBody = (values: Values): McpServerCreateIn => ({
  authMode: values.authMode,
  description: values.description.trim(),
  headers: headersOf(values.headers),
  id: values.id.trim(),
  name: values.name.trim(),
  timeoutSeconds: values.timeout,
  transport: values.transport,
  url: values.url.trim(),
})

/** 修改的请求体：地址、权限范围、客户端只在改过时带上；没填的客户端密钥不带，沿用原来的。 */
export const updateBody = (values: Values, server: McpServer): McpServerUpdateIn => {
  const url = values.url.trim()
  const body: McpServerUpdateIn = {
    authMode: values.authMode,
    description: values.description.trim(),
    headers: headersOf(values.headers),
    name: values.name.trim(),
    timeoutSeconds: values.timeout,
    transport: values.transport,
  }
  if (url !== server.url) body.url = url
  if (values.authMode !== 'per_user') return body
  const scopes = scopeRowsOf(values, server)
  if (scopes !== null && !sameRows(scopes, savedScopeRows(server)))
    body.oauthScopes = scopes.filter((row) => row.on).map((row) => row.name)
  const clientId = values.clientId.trim()
  if (
    showsClient(values, server) &&
    clientId !== '' &&
    (clientId !== (server.oauth.presetClient?.clientId ?? '') || values.clientSecret !== '')
  )
    body.oauthClient =
      values.clientSecret === '' ? { clientId } : { clientId, clientSecret: values.clientSecret }
  return body
}
