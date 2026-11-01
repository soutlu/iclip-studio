/**
 * MCP 服务的 mock：四个服务（通了的、SSE 的、上次没连上的、还没测试过的），形状照合同 §22。增改删与试连改内存里的数据，
 * 请求头存明文、答复只给打码值；试连按地址判：含 `invalid` 或 `fail` 的连不上，其余都通。每例由
 * `resetMockMcpServers` 放回预置数据。
 */

import { http, HttpResponse } from 'msw'
import type {
  AgentUsageOut,
  McpCheckIn,
  McpCheckOut,
  McpHeaderIn,
  McpServerCreateIn,
  McpServerOut,
  McpServerUpdateIn,
} from '@/shared/api/generated/types.gen'

type Tool = { name: string; description: string | null }

type MockServer = Omit<McpServerOut, 'headers' | 'usedBy'> & {
  headers: { name: string; value: string }[]
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const ADMIN = '00000000-0000-4000-8000-000100000001'

const FEISHU_TOOLS: Tool[] = [
  { description: '按关键词查找团队资料', name: 'search' },
  { description: '获取文档正文与结构', name: 'read' },
  { description: '查看文件夹中的文档', name: 'folders' },
  { description: '了解文档中的讨论与反馈', name: 'comments' },
  { description: '将创作方案整理为新文档', name: 'create' },
  { description: '修改已有文档的内容', name: 'update' },
]

/** 新登记的服务试连通了时发现的工具。 */
const DEFAULT_TOOLS: Tool[] = [
  { description: '按关键词检索内容', name: 'search' },
  { description: '获取单条内容详情', name: 'read' },
]

const server = (
  fields: Pick<MockServer, 'description' | 'headers' | 'id' | 'name' | 'transport' | 'url'>,
  check: { ok: boolean; elapsedMs: number; reason: string | null } | null,
  tools: Tool[] | null,
): MockServer => ({
  ...fields,
  createdAt: ago(60 * 24 * 20),
  createdBy: ADMIN,
  enabled: true,
  lastCheck: check === null ? null : { ...check, checkedAt: ago(60) },
  timeoutSeconds: 30,
  tools,
  updatedAt: ago(60 * 24),
  updatedBy: ADMIN,
})

const seed = (): MockServer[] => [
  server(
    {
      description: '查阅团队文档与创作资料',
      headers: [{ name: 'Authorization', value: 'Bearer feishu-DEMO' }],
      id: 'feishu-docs',
      name: '飞书文档',
      transport: 'streamable_http',
      url: 'https://docs.example/mcp',
    },
    { elapsedMs: 142, ok: true, reason: null },
    FEISHU_TOOLS,
  ),
  server(
    {
      description: '寻找参考图与视觉灵感',
      headers: [],
      id: 'image-search',
      name: '图库检索',
      transport: 'sse',
      url: 'https://gallery.example/sse',
    },
    { elapsedMs: 96, ok: true, reason: null },
    [
      { description: '按主题与画面内容检索素材', name: 'search_images' },
      { description: '了解图片尺寸、来源与说明', name: 'image_details' },
      { description: '查看按主题整理的参考素材', name: 'collections' },
    ],
  ),
  server(
    {
      description: '读取品牌规范、Logo 与包装素材',
      headers: [{ name: 'Authorization', value: 'Bearer brand-DEMO' }],
      id: 'brand-assets',
      name: '品牌资产库',
      transport: 'streamable_http',
      url: 'https://brand-assets.invalid/mcp',
    },
    { elapsedMs: 3000, ok: false, reason: '连不上 brand-assets.invalid：域名解析失败' },
    [
      { description: '获取色彩、字体与版式规则', name: 'guidelines' },
      { description: '按场景取用 Logo 文件', name: 'logos' },
      { description: '检索产品包装与陈列图', name: 'packshots' },
      { description: '取用授权字体文件', name: 'fonts' },
      { description: '检索可商用的品牌配乐', name: 'music' },
    ],
  ),
  // 刚登记、还没测试过：没有发现的工具，挂上后发布会被拦下。
  server(
    {
      description: '查询客户跟进记录',
      headers: [],
      id: 'crm-notes',
      name: '客户笔记',
      transport: 'streamable_http',
      url: 'https://crm.example/mcp',
    },
    null,
    null,
  ),
]

let servers = seed()

export const resetMockMcpServers = () => {
  servers = seed()
}

/** 此刻登记着的一个服务（发布检查要看它在不在、启没启用、发现过哪些工具）；没有为 undefined。 */
export const mockMcpServer = (
  id: string,
): Pick<McpServerOut, 'enabled' | 'id' | 'name' | 'tools'> | undefined =>
  servers.find((item) => item.id === id)

const mask = (value: string) => (value.length < 8 ? '••••' : `••••${value.slice(-4)}`)

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

const invalid = (detail: string) => HttpResponse.json({ detail }, { status: 422 })
const notFound = () => HttpResponse.json({ detail: 'MCP 服务不存在' }, { status: 404 })

/** 按地址判通不通；通了交出工具：已登记的服务交它上次发现的，新的交两个默认工具。 */
const probe = (url: string, known: MockServer | undefined): McpCheckOut => {
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  if (/invalid|fail/i.test(url))
    return { elapsedMs: 3000, ok: false, reason: `连不上 ${host}：域名解析失败`, tools: null }
  const elapsedMs =
    60 + ([...url].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 997, 0) % 180)
  return { elapsedMs, ok: true, reason: null, tools: known?.tools ?? DEFAULT_TOOLS }
}

/**
 * 按合同 §22 合出请求头：给了 `current`（改已保存的服务、或带 `serverId` 试连）时没给值的取同名原值，
 * 没有这个名字就不合格；没给 `current` 时每个都要给值。不合格交回原因。
 */
const resolveHeaders = (
  headers: readonly McpHeaderIn[],
  current: MockServer['headers'] | null,
): MockServer['headers'] | string => {
  if (headers.length > 20) return '请求头最多 20 个'
  const seen = new Set<string>()
  const resolved: MockServer['headers'] = []
  for (const header of headers) {
    const key = header.name.toLowerCase()
    if (seen.has(key)) return `请求头 ${header.name} 重复`
    seen.add(key)
    if (header.value !== null && header.value !== undefined && header.value !== '') {
      resolved.push({ name: header.name, value: header.value })
      continue
    }
    const previous = current?.find((item) => item.name.toLowerCase() === key)
    if (previous === undefined) return `请求头 ${header.name} 没有给值`
    resolved.push({ name: header.name, value: previous.value })
  }
  return resolved
}

const checkUrl = (url: string) => {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname !== ''
  } catch {
    return false
  }
}

const inUseMessage = (item: MockServer, usages: AgentUsageOut[]) =>
  `MCP 服务 ${item.name} 还在被这些 agent 使用：${usages
    .map(
      (usage) =>
        `${usage.agentName}（${usage.agentId}，${
          usage.inDraft && usage.inActiveVersion
            ? '草稿与当前版本'
            : usage.inDraft
              ? '草稿'
              : '当前版本'
        }）`,
    )
    .join('、')}；先在它们的草稿与当前版本里去掉再操作`

/** MCP 服务的全部端点；`usage` 答某个服务被哪些 agent 的草稿或当前版本挂着。 */
export const mcpServerHandlers = (usage: (serverId: string) => AgentUsageOut[]) => {
  const toOut = (item: MockServer): McpServerOut => ({
    ...item,
    headers: item.headers.map((header) => ({ name: header.name, value: mask(header.value) })),
    usedBy: usage(item.id),
  })
  const find = (id: unknown) => servers.find((item) => item.id === String(id))
  return [
    http.get('*/api/mcp-servers', () => HttpResponse.json({ items: servers.map(toOut) })),

    http.post('*/api/mcp-servers/check', async ({ request }) => {
      const body = (await request.json()) as McpCheckIn
      const known =
        body.serverId === null || body.serverId === undefined ? undefined : find(body.serverId)
      if (body.serverId !== null && body.serverId !== undefined && known === undefined)
        return notFound()
      if (!checkUrl(body.url)) return invalid('地址要以 http:// 或 https:// 开头并带主机')
      const headers = resolveHeaders(body.headers ?? [], known?.headers ?? null)
      if (typeof headers === 'string') return invalid(headers)
      return HttpResponse.json(probe(body.url, known))
    }),

    http.post('*/api/mcp-servers', async ({ request }) => {
      const body = (await request.json()) as McpServerCreateIn
      if (!ID_PATTERN.test(body.id)) return invalid(`标识「${body.id}」不可用`)
      if (find(body.id) !== undefined)
        return HttpResponse.json({ detail: `标识「${body.id}」已被占用` }, { status: 409 })
      if (!checkUrl(body.url)) return invalid('地址要以 http:// 或 https:// 开头并带主机')
      const headers = resolveHeaders(body.headers ?? [], null)
      if (typeof headers === 'string') return invalid(headers)
      const created: MockServer = {
        ...server(
          {
            description: body.description ?? '',
            headers,
            id: body.id,
            name: body.name,
            transport: body.transport,
            url: body.url,
          },
          null,
          null,
        ),
        createdAt: new Date().toISOString(),
        enabled: body.enabled ?? true,
        timeoutSeconds: body.timeoutSeconds ?? 30,
        updatedAt: new Date().toISOString(),
      }
      servers.push(created)
      return HttpResponse.json(toOut(created), { status: 201 })
    }),

    http.get('*/api/mcp-servers/:serverId', ({ params }) => {
      const item = find(params['serverId'])
      return item === undefined ? notFound() : HttpResponse.json(toOut(item))
    }),

    http.patch('*/api/mcp-servers/:serverId', async ({ params, request }) => {
      const item = find(params['serverId'])
      if (item === undefined) return notFound()
      const body = (await request.json()) as McpServerUpdateIn
      if (body.url !== null && body.url !== undefined && !checkUrl(body.url))
        return invalid('地址要以 http:// 或 https:// 开头并带主机')
      if (body.enabled === false && usage(item.id).length > 0)
        return HttpResponse.json({ detail: inUseMessage(item, usage(item.id)) }, { status: 409 })
      if (body.headers !== null && body.headers !== undefined) {
        const headers = resolveHeaders(body.headers, item.headers)
        if (typeof headers === 'string') return invalid(headers)
        item.headers = headers
      }
      const connectionChanged =
        (body.url !== null && body.url !== undefined && body.url !== item.url) ||
        (body.transport !== null &&
          body.transport !== undefined &&
          body.transport !== item.transport)
      item.name = body.name ?? item.name
      item.description = body.description ?? item.description
      item.url = body.url ?? item.url
      item.transport = body.transport ?? item.transport
      item.timeoutSeconds = body.timeoutSeconds ?? item.timeoutSeconds
      item.enabled = body.enabled ?? item.enabled
      if (connectionChanged) {
        item.lastCheck = null
        item.tools = null
      }
      item.updatedAt = new Date().toISOString()
      return HttpResponse.json(toOut(item))
    }),

    http.delete('*/api/mcp-servers/:serverId', ({ params }) => {
      const item = find(params['serverId'])
      if (item === undefined) return notFound()
      const users = usage(item.id)
      if (users.length > 0)
        return HttpResponse.json({ detail: inUseMessage(item, users) }, { status: 409 })
      servers = servers.filter((other) => other.id !== item.id)
      return new HttpResponse(null, { status: 204 })
    }),

    http.post('*/api/mcp-servers/:serverId/check', ({ params }) => {
      const item = find(params['serverId'])
      if (item === undefined) return notFound()
      const result = probe(item.url, item)
      item.lastCheck = {
        checkedAt: new Date().toISOString(),
        elapsedMs: result.elapsedMs,
        ok: result.ok,
        reason: result.reason,
      }
      if (result.ok) item.tools = result.tools
      return HttpResponse.json(result)
    }),
  ]
}
