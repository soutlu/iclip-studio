export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type JsonPath = string

export type JsonLine = {
  id: string
  depth: number
  key: string | undefined
  comma: boolean
  body:
    | { type: 'value'; value: JsonPrimitive }
    | { type: 'empty'; brackets: '{}' | '[]' }
    | { type: 'open'; path: JsonPath; label: string; bracket: '{' | '[' }
    | { type: 'close'; bracket: '}' | ']' }
    | { type: 'folded'; path: JsonPath; label: string; brackets: '{…}' | '[…]'; count: number }
}

const FULLY_EXPANDED_MAX_LINES = 200

type Container = JsonValue[] | { [key: string]: JsonValue }

const isContainer = (value: JsonValue): value is Container =>
  typeof value === 'object' && value !== null

const entriesOf = (value: Container): [string, JsonValue][] =>
  Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value)

const childPath = (path: JsonPath, key: string): JsonPath =>
  `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`

const childLabel = (label: string | undefined, key: string, inArray: boolean): string => {
  if (inArray) return `${label ?? ''}[${key}]`
  return label === undefined ? key : `${label}.${key}`
}

export const parseJson = (text: string): { ok: true; value: JsonValue } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue }
  } catch {
    return { ok: false }
  }
}

type ContainerInfo = { path: JsonPath; depth: number }

const containersOf = (value: JsonValue): ContainerInfo[] => {
  const found: ContainerInfo[] = []
  const walk = (node: JsonValue, path: JsonPath, depth: number) => {
    if (!isContainer(node)) return
    const entries = entriesOf(node)
    if (entries.length === 0) return
    found.push({ depth, path })
    for (const [key, child] of entries) walk(child, childPath(path, key), depth + 1)
  }
  walk(value, '', 0)
  return found
}

export const defaultCollapsed = (value: JsonValue): Set<JsonPath> => {
  const lines = JSON.stringify(value, null, 2).split('\n').length
  if (lines <= FULLY_EXPANDED_MAX_LINES) return new Set()
  return new Set(
    containersOf(value)
      .filter((container) => container.depth >= 2)
      .map((container) => container.path),
  )
}

export const collapsedBelowRoot = (value: JsonValue): Set<JsonPath> =>
  new Set(
    containersOf(value)
      .filter((container) => container.depth >= 1)
      .map((container) => container.path),
  )

export const layoutJson = (value: JsonValue, collapsed: ReadonlySet<JsonPath>): JsonLine[] => {
  const lines: JsonLine[] = []
  const walk = (
    node: JsonValue,
    path: JsonPath,
    depth: number,
    key: string | undefined,
    label: string | undefined,
    comma: boolean,
  ) => {
    const base = { comma, depth, id: path, key }
    if (!isContainer(node)) {
      lines.push({ ...base, body: { type: 'value', value: node } })
      return
    }
    const inArray = Array.isArray(node)
    const entries = entriesOf(node)
    if (entries.length === 0) {
      lines.push({ ...base, body: { brackets: inArray ? '[]' : '{}', type: 'empty' } })
      return
    }
    const name = label ?? '根'
    if (collapsed.has(path)) {
      lines.push({
        ...base,
        body: {
          brackets: inArray ? '[…]' : '{…}',
          count: entries.length,
          label: name,
          path,
          type: 'folded',
        },
      })
      return
    }
    lines.push({
      ...base,
      body: { bracket: inArray ? '[' : '{', label: name, path, type: 'open' },
      comma: false,
    })
    entries.forEach(([childKey, child], index) =>
      walk(
        child,
        childPath(path, childKey),
        depth + 1,
        inArray ? undefined : childKey,
        childLabel(label, childKey, inArray),
        index < entries.length - 1,
      ),
    )
    lines.push({
      ...base,
      body: { bracket: inArray ? ']' : '}', type: 'close' },
      id: `end:${path}`,
      key: undefined,
    })
  }
  walk(value, '', 0, undefined, undefined, false)
  return lines
}
