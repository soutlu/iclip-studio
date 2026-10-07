/**
 * JSON 文件的格式化视图：解析后按 2 空格缩进重新排成行，与 JSON.stringify(value, null, 2) 同一套排法；
 * 每个非空的对象与数组可以收起成一行 `{…}` / `[…]`。只认解析出的值，原文里的空白与 `1.0` 这类写法不保留。
 */

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** 容器的定位键：根是空串，往下每一层接 `/` 加转义后的键名或下标（JSON Pointer 写法）。 */
export type JsonPath = string

export type JsonLine = {
  /** 本行在整份视图里唯一，作列表 key。 */
  id: string
  /** 缩进层级：根为 0，每深一层多缩进 2 格。 */
  depth: number
  /** 对象成员带键名；数组元素与根没有。 */
  key: string | undefined
  /** 行尾要不要逗号。 */
  comma: boolean
  body:
    | { type: 'value'; value: JsonPrimitive }
    | { type: 'empty'; brackets: '{}' | '[]' }
    | { type: 'open'; path: JsonPath; label: string; bracket: '{' | '[' }
    | { type: 'close'; bracket: '}' | ']' }
    | { type: 'folded'; path: JsonPath; label: string; brackets: '{…}' | '[…]'; count: number }
}

/** 格式化后不超过这么多行就全部展开，超过只展开前两层。 */
const FULLY_EXPANDED_MAX_LINES = 200

type Container = JsonValue[] | { [key: string]: JsonValue }

const isContainer = (value: JsonValue): value is Container =>
  typeof value === 'object' && value !== null

const entriesOf = (value: Container): [string, JsonValue][] =>
  Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value)

const childPath = (path: JsonPath, key: string): JsonPath =>
  `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`

/** 给读屏用的名字：`shots[0].prompt` 这样的写法，根叫「根」。 */
const childLabel = (label: string | undefined, key: string, inArray: boolean): string => {
  if (inArray) return `${label ?? ''}[${key}]`
  return label === undefined ? key : `${label}.${key}`
}

// 解析器的报错是英文位置信息，不展示给用户；原文就在下方，足够定位。
export const parseJson = (text: string): { ok: true; value: JsonValue } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue }
  } catch {
    return { ok: false }
  }
}

type ContainerInfo = { path: JsonPath; depth: number }

/** 全部非空容器（含根），按出现顺序。 */
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

/** 默认收起哪些：全部展开时不超过 200 行就都不收；超过只留根与第一层展开，第二层起收起。 */
export const defaultCollapsed = (value: JsonValue): Set<JsonPath> => {
  const lines = JSON.stringify(value, null, 2).split('\n').length
  if (lines <= FULLY_EXPANDED_MAX_LINES) return new Set()
  return new Set(
    containersOf(value)
      .filter((container) => container.depth >= 2)
      .map((container) => container.path),
  )
}

/** 「全部收起」：根保持展开，只露出第一层，第一层起的容器都收起。 */
export const collapsedBelowRoot = (value: JsonValue): Set<JsonPath> =>
  new Set(
    containersOf(value)
      .filter((container) => container.depth >= 1)
      .map((container) => container.path),
  )

/** 按收起状态排出所有行。 */
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
      // 收尾括号只带容器的逗号，键名留在开头那一行。
      key: undefined,
    })
  }
  walk(value, '', 0, undefined, undefined, false)
  return lines
}
