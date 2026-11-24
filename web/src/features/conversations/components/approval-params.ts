export type ApprovalParams = Readonly<Record<string, unknown>>

export type ParamRow = {
  key: string
  value: string
  numeric: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const approvalParams = (input: unknown): ApprovalParams | undefined => {
  const value = typeof input === 'string' ? parsed(input) : input
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined
}

export const paramRows = (params: ApprovalParams): ParamRow[] => {
  const rows: ParamRow[] = []
  const visit = (value: unknown, key: string) => {
    if (value === null || value === undefined || value === '') return
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, value.length === 1 ? key : `${key}[${index + 1}]`))
      return
    }
    if (isRecord(value)) {
      for (const [name, child] of Object.entries(value))
        visit(child, key === '' ? name : `${key}.${name}`)
      return
    }
    if (typeof value === 'string') rows.push({ key, numeric: false, value })
    else if (typeof value === 'number' || typeof value === 'boolean')
      rows.push({ key, numeric: true, value: String(value) })
  }
  visit(params, '')
  return rows
}

const IMAGE_URL = /^https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?$/i

const MAX_IMAGES = 4

export const paramImages = (params: ApprovalParams): string[] => {
  const urls: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (IMAGE_URL.test(value) && !urls.includes(value)) urls.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (isRecord(value)) {
      Object.values(value).forEach(visit)
    }
  }
  visit(params)
  return urls.slice(0, MAX_IMAGES)
}

const ASCII_IDENTIFIER = /^[A-Za-z0-9_.-]+$/

export const isAsciiIdentifier = (text: string): boolean => ASCII_IDENTIFIER.test(text)

const MCP_TOOL = /^mcp_([^_]+)_/

export const mcpServerIdOf = (toolName: string): string | undefined => MCP_TOOL.exec(toolName)?.[1]
