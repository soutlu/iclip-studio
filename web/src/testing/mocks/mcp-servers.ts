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

type Tool = { name: string; title: string | null; description: string | null }

type MockServer = Omit<McpServerOut, 'headers' | 'usedBy'> & {
  headers: { name: string; value: string }[]
  /** 当前管理员在这个使用自有账户的服务上有没有连接（测试已保存的服务时用）。 */
  adminConnected: boolean
}

const SIGN_IN_SCOPES = ['openid', 'email', 'profile', 'offline_access']

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const ADMIN = '00000000-0000-4000-8000-000100000001'

const FEISHU_TOOLS: Tool[] = [
  { description: '按关键词查找团队资料', name: 'search', title: '搜索文档' },
  { description: '获取文档正文与结构', name: 'read', title: '读取文档' },
  { description: '查看文件夹中的文档', name: 'folders', title: null },
  { description: '了解文档中的讨论与反馈', name: 'comments', title: null },
  { description: '将创作方案整理为新文档', name: 'create', title: null },
  { description: '修改已有文档的内容', name: 'update', title: null },
]

const PICKFU_TOOLS: Tool[] = [
  { description: '新建或修改调研草稿', name: 'save_survey', title: '保存调研' },
  { description: '读取调研的设置与状态', name: 'get_survey', title: '查看调研' },
  { description: '列出团队里的调研', name: 'list_surveys', title: '调研列表' },
  { description: '读取受访者的回答', name: 'get_survey_responses', title: '查看回答' },
  { description: '发布调研并付款', name: 'publish_survey', title: '发布调研' },
  { description: '给已完成的调研增加受访者', name: 'add_respondents', title: '追加样本' },
  { description: '导出调研结果', name: 'export_survey_results', title: '导出结果' },
  { description: '查看可用的调研模板', name: 'list_templates', title: '模板列表' },
  { description: '查看可选的受访人群', name: 'list_audiences', title: '受访人群' },
  { description: '按样本量估算调研费用', name: 'estimate_cost', title: '估算费用' },
  { description: '上传调研要用的图片或视频', name: 'upload_media', title: '上传素材' },
  { description: '查看团队的调研余额', name: 'get_balance', title: '账户余额' },
]

const DEFAULT_TOOLS: Tool[] = [
  { description: '按关键词检索内容', name: 'search', title: null },
  { description: '获取单条内容详情', name: 'read', title: null },
]

const server = (
  fields: Pick<MockServer, 'description' | 'headers' | 'id' | 'name' | 'transport' | 'url'>,
  check: { ok: boolean; elapsedMs: number; reason: string | null } | null,
  tools: Tool[] | null,
): MockServer => ({
  ...fields,
  adminConnected: false,
  authMode: 'shared',
  createdAt: ago(60 * 24 * 20),
  createdBy: ADMIN,
  enabled: true,
  lastCheck: check === null ? null : { ...check, checkedAt: ago(60) },
  oauth: {
    client: 'unknown',
    connectedUsers: 0,
    presetClient: null,
    publishedScopes: null,
    requestedScopes: null,
    scopes: null,
    signInScopes: null,
  },
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
      { description: '按主题与画面内容检索素材', name: 'search_images', title: null },
      { description: '了解图片尺寸、来源与说明', name: 'image_details', title: null },
      { description: '查看按主题整理的参考素材', name: 'collections', title: null },
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
      { description: '获取色彩、字体与版式规则', name: 'guidelines', title: null },
      { description: '按场景取用 Logo 文件', name: 'logos', title: null },
      { description: '检索产品包装与陈列图', name: 'packshots', title: null },
      { description: '取用授权字体文件', name: 'fonts', title: null },
      { description: '检索可商用的品牌配乐', name: 'music', title: null },
    ],
  ),
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
  {
    ...server(
      {
        description: '消费者调研',
        headers: [{ name: 'X-PickFu-Team', value: 'team-DEMO' }],
        id: 'pickfu',
        name: 'PickFu',
        transport: 'streamable_http',
        url: 'https://mcp.pickfu.com/mcp',
      },
      null,
      null,
    ),
    adminConnected: true,
    authMode: 'per_user',
    oauth: {
      client: 'automatic',
      connectedUsers: 3,
      presetClient: null,
      publishedScopes: null,
      requestedScopes: null,
      scopes: null,
      signInScopes: null,
    },
  },
  {
    ...server(
      {
        description: '访谈记录与用户反馈',
        headers: [],
        id: 'user-insights',
        name: '用户洞察',
        transport: 'streamable_http',
        url: 'https://insights.example/mcp',
      },
      null,
      null,
    ),
    authMode: 'per_user',
    oauth: {
      client: 'required',
      connectedUsers: 0,
      presetClient: null,
      publishedScopes: null,
      requestedScopes: null,
      scopes: null,
      signInScopes: null,
    },
  },
]

let servers = seed()

export const resetMockMcpServers = () => {
  servers = seed()
}

export const mockMcpServer = (
  id: string,
): Pick<McpServerOut, 'enabled' | 'id' | 'name' | 'tools'> | undefined =>
  servers.find((item) => item.id === id)

const mask = (value: string) => (value.length < 8 ? '••••' : `••••${value.slice(-4)}`)

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

const invalid = (detail: string) => HttpResponse.json({ detail }, { status: 422 })
const notFound = () => HttpResponse.json({ detail: 'MCP 服务不存在' }, { status: 404 })

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
  const tools = known?.tools ?? (known?.id === 'pickfu' ? PICKFU_TOOLS : DEFAULT_TOOLS)
  return { elapsedMs, ok: true, reason: null, tools }
}

const PUBLISHED_SCOPES: Partial<Record<string, string[]>> = { pickfu: ['read', 'write', 'spend'] }

const chosenScopes = (item: MockServer): string[] =>
  item.oauth.scopes ?? item.oauth.publishedScopes ?? []

const cleanScopes = (given: readonly string[]) =>
  [...new Set(given.map((scope) => scope.trim()))].filter(
    (scope) => scope !== '' && !SIGN_IN_SCOPES.includes(scope),
  )

/** 测试已保存的服务时一并读到服务公布的权限范围。 */
const discoverOAuth = (item: MockServer) => {
  const published = PUBLISHED_SCOPES[item.id] ?? []
  item.oauth = {
    ...item.oauth,
    publishedScopes: published,
    signInScopes: SIGN_IN_SCOPES,
    requestedScopes: [...(item.oauth.scopes ?? published), ...SIGN_IN_SCOPES],
  }
}

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

export const mcpServerHandlers = (usage: (serverId: string) => AgentUsageOut[]) => {
  const toOut = ({ adminConnected: _adminConnected, ...item }: MockServer): McpServerOut => ({
    ...item,
    headers: item.headers.map((header) => ({ name: header.name, value: mask(header.value) })),
    usedBy: usage(item.id),
  })
  const find = (id: unknown) => servers.find((item) => item.id === String(id))
  const duplicate = (self: MockServer | undefined, url: string, name: string) => {
    const others = servers.filter((item) => item !== self)
    const sameUrl = others.find((item) => item.url === url.trim())
    if (sameUrl !== undefined)
      return HttpResponse.json({ detail: `这个地址已经登记过：${sameUrl.name}` }, { status: 409 })
    if (others.some((item) => item.name === name.trim()))
      return HttpResponse.json({ detail: `这个名称已经有了：${name.trim()}` }, { status: 409 })
    return undefined
  }
  return [
    http.get('*/api/mcp-servers', () => HttpResponse.json({ items: servers.map(toOut) })),

    http.get(/\/api\/mcp-servers:callback-url$/, () =>
      HttpResponse.json({ callbackUrl: 'https://iclip.example/mcp/callback' }),
    ),

    http.post('*/api/mcp-servers/check', async ({ request }) => {
      const body = (await request.json()) as McpCheckIn
      const known =
        body.serverId === null || body.serverId === undefined ? undefined : find(body.serverId)
      if (body.serverId !== null && body.serverId !== undefined && known === undefined)
        return notFound()
      if ((body.authMode ?? known?.authMode) === 'per_user')
        return invalid('使用自有账户的服务要先保存，再测试连接')
      const url = body.url ?? known?.url
      if (url === undefined) return invalid('请填写地址')
      if (!checkUrl(url)) return invalid('地址要以 http:// 或 https:// 开头并带主机')
      const headers = resolveHeaders(body.headers ?? [], known?.headers ?? null)
      if (typeof headers === 'string') return invalid(headers)
      return HttpResponse.json(probe(url, known))
    }),

    http.post('*/api/mcp-servers', async ({ request }) => {
      const body = (await request.json()) as McpServerCreateIn
      if (!ID_PATTERN.test(body.id)) return invalid(`标识「${body.id}」不可用`)
      if (find(body.id) !== undefined)
        return HttpResponse.json({ detail: `标识「${body.id}」已被占用` }, { status: 409 })
      if (!checkUrl(body.url)) return invalid('地址要以 http:// 或 https:// 开头并带主机')
      const duplicated = duplicate(undefined, body.url, body.name)
      if (duplicated !== undefined) return duplicated
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
        authMode: body.authMode ?? 'shared',
        createdAt: new Date().toISOString(),
        enabled: body.enabled ?? true,
        timeoutSeconds: body.timeoutSeconds ?? 30,
        updatedAt: new Date().toISOString(),
      }
      if (body.oauthScopes !== null && body.oauthScopes !== undefined)
        created.oauth.scopes = cleanScopes(body.oauthScopes)
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
      const duplicated = duplicate(item, body.url ?? item.url, body.name ?? item.name)
      if (duplicated !== undefined) return duplicated
      if (body.enabled === false && usage(item.id).length > 0)
        return HttpResponse.json({ detail: inUseMessage(item, usage(item.id)) }, { status: 409 })
      const headers =
        body.headers === null || body.headers === undefined
          ? item.headers
          : resolveHeaders(body.headers, item.headers)
      if (typeof headers === 'string') return invalid(headers)
      const authMode = body.authMode ?? item.authMode
      const moved = body.url !== null && body.url !== undefined && body.url !== item.url
      const scopes =
        body.oauthScopes === null || body.oauthScopes === undefined
          ? item.oauth.scopes
          : cleanScopes(body.oauthScopes)
      const preset = item.oauth.presetClient
      const client = body.oauthClient ?? null
      const ending = moved || (item.authMode === 'per_user' && authMode === 'shared')
      const narrowed =
        item.oauth.publishedScopes !== null &&
        scopes !== null &&
        chosenScopes(item).some((scope) => !scopes.includes(scope))
      const orphaned = client !== null && preset !== null && client.clientId !== preset.clientId
      const affected =
        item.authMode === 'per_user' && (ending || narrowed || orphaned)
          ? item.oauth.connectedUsers
          : 0
      if (affected > 0 && body.confirmReconnect !== true)
        return HttpResponse.json(
          {
            affectedUsers: affected,
            code: 'mcp_connections_affected',
            detail: `这次修改会让已连接的 ${affected} 人需要重新连接`,
          },
          { status: 409 },
        )
      // 以上都不改动服务；确认过或不影响任何人才落库。
      const connectionChanged =
        moved ||
        (body.transport !== null &&
          body.transport !== undefined &&
          body.transport !== item.transport)
      item.headers = headers
      item.authMode = authMode
      item.oauth = { ...item.oauth, scopes }
      if (item.oauth.publishedScopes !== null)
        item.oauth.requestedScopes = [...(scopes ?? item.oauth.publishedScopes), ...SIGN_IN_SCOPES]
      if (client !== null) {
        const secret =
          client.clientSecret !== null && client.clientSecret !== undefined
            ? mask(client.clientSecret)
            : preset?.clientId === client.clientId
              ? preset.clientSecret
              : null
        item.oauth = {
          ...item.oauth,
          client: 'preset',
          presetClient: { clientId: client.clientId, clientSecret: secret },
        }
      }
      if (moved)
        item.oauth = {
          ...item.oauth,
          publishedScopes: null,
          requestedScopes: null,
          signInScopes: null,
        }
      if (ending) item.adminConnected = false
      if (affected > 0) item.oauth = { ...item.oauth, connectedUsers: 0 }
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
      if (item.authMode === 'per_user' && !item.adminConnected)
        return HttpResponse.json(
          { code: 'mcp_not_connected', detail: `你还没有连接 ${item.name}，请先连接再测试` },
          { status: 409 },
        )
      const result = probe(item.url, item)
      item.lastCheck = {
        checkedAt: new Date().toISOString(),
        elapsedMs: result.elapsedMs,
        ok: result.ok,
        reason: result.reason,
      }
      if (result.ok) item.tools = result.tools
      if (result.ok && item.authMode === 'per_user') discoverOAuth(item)
      return HttpResponse.json(result)
    }),
  ]
}
