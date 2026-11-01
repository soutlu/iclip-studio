import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { AgentPreviewConversation } from '@/routes/-agent-preview-conversation'
import { AgentConfigPage } from './agent-config-page'

type Body = Record<string, unknown>
type User = ReturnType<typeof userEvent.setup>

function Harness() {
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  return (
    <AgentConfigPage
      agentId={agentId}
      onAgentChange={setAgentId}
      PreviewConversation={AgentPreviewConversation}
    />
  )
}

const renderPage = async () => {
  loginAs(mockGovernor)
  const user = userEvent.setup()
  await renderWithProviders(<Harness />)
  await screen.findByRole('button', { name: /^切换 Agent，当前：/ })
  return user
}

/** 记下发往某个端点的请求体，响应仍交给预置的 mock。 */
const recordBodies = (method: 'PUT' | 'POST' | 'PATCH', path: RegExp) => {
  const bodies: Body[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method !== method || !path.test(new URL(request.url).pathname)) return
    void request
      .clone()
      .json()
      .then((body: Body) => bodies.push(body))
  })
  return bodies
}

const editor = () => screen.getByRole('region', { name: 'Agent 配置编辑器' })
const mcpSection = () => within(editor()).getByRole('region', { name: 'MCP 服务' })
const sidePanel = () => screen.getByRole('region', { name: '配置调整' })

const openLibrary = async (user: User) => {
  await user.click(screen.getByRole('tab', { name: 'MCP 服务' }))
  expect(within(sidePanel()).getByRole('heading', { name: 'MCP 服务' })).toBeVisible()
  return sidePanel()
}

const openFromLibrary = async (user: User, name: string) => {
  const library = await openLibrary(user)
  await user.click(await within(library).findByRole('button', { name: `编辑 MCP 服务：${name}` }))
  return sidePanel()
}

const openCard = async (user: User, name: string) => {
  await user.click(
    await within(mcpSection()).findByRole('button', { name: `配置 MCP 服务：${name}` }),
  )
  return sidePanel()
}

const field = (panel: HTMLElement, name: string) => within(panel).getByRole('textbox', { name })

/** 测试连接通过后「保存配置」才可点，等它可点再点。 */
const saveWhenTested = async (user: User, panel: HTMLElement) => {
  const save = within(panel).getByRole('button', { name: '保存配置' })
  await waitFor(() => expect(save).toBeEnabled())
  await user.click(save)
}

describe('MCP 服务 添加', () => {
  it('测试通过才能保存；保存后服务出现在库里，标题换成配置', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const creates = recordBodies('POST', /\/api\/mcp-servers$/)
    const library = await openLibrary(user)
    await user.click(within(library).getByRole('button', { name: '添加服务' }))
    const panel = sidePanel()
    expect(within(panel).getByRole('heading', { name: '添加 MCP 服务' })).toBeVisible()
    const save = within(panel).getByRole('button', { name: '保存配置' })
    expect(save).toBeDisabled()

    // 必填项没填时不发试连。
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    expect(field(panel, '服务名称')).toHaveAccessibleDescription('请填写服务名称')
    expect(field(panel, '标识')).toHaveAccessibleDescription('请填写标识')
    expect(checks).toHaveLength(0)

    await user.type(field(panel, '服务名称'), '素材检索')
    await user.type(field(panel, '标识'), 'asset-search')
    await user.type(within(panel).getByLabelText('服务地址'), 'https://assets.example/mcp')
    await user.click(within(panel).getByRole('radio', { name: 'SSE' }))
    await user.click(within(panel).getByRole('button', { name: '添加请求头' }))
    await user.type(field(panel, '请求头名称 1'), 'X-Api-Key')
    await user.type(within(panel).getByLabelText('请求头的值 1'), 'secret-1234')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))

    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent(/\d+ ms/))
    expect(checks).toEqual([
      {
        headers: [{ name: 'X-Api-Key', value: 'secret-1234' }],
        serverId: null,
        timeoutSeconds: 30,
        transport: 'sse',
        url: 'https://assets.example/mcp',
      },
    ])
    await saveWhenTested(user, panel)

    expect(await within(sidePanel()).findByRole('heading', { name: '配置 MCP' })).toBeVisible()
    expect(creates).toEqual([
      {
        description: '',
        headers: [{ name: 'X-Api-Key', value: 'secret-1234' }],
        id: 'asset-search',
        name: '素材检索',
        timeoutSeconds: 30,
        transport: 'sse',
        url: 'https://assets.example/mcp',
      },
    ])
    // 存下的服务记着试连结果，再保存要重新测试。
    expect(within(sidePanel()).getByRole('status')).toHaveTextContent(/\d+ ms/)
    expect(within(sidePanel()).getByRole('button', { name: '保存配置' })).toBeDisabled()
    expect(within(sidePanel()).getByLabelText('请求头的值 1')).toHaveAttribute(
      'placeholder',
      '••••1234',
    )

    await user.click(within(sidePanel()).getByRole('button', { name: '返回' }))
    const row = await within(sidePanel()).findByRole('button', { name: '编辑 MCP 服务：素材检索' })
    expect(within(row).getByRole('img', { name: '已连接' })).toBeInTheDocument()
  })

  it('标识已被占用：原因写在标识下面', async () => {
    const user = await renderPage()
    await user.click(within(await openLibrary(user)).getByRole('button', { name: '添加服务' }))
    const panel = sidePanel()
    await user.type(field(panel, '服务名称'), '另一个飞书')
    await user.type(field(panel, '标识'), 'feishu-docs')
    await user.type(within(panel).getByLabelText('服务地址'), 'https://docs2.example/mcp')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await saveWhenTested(user, panel)

    await waitFor(() =>
      expect(field(panel, '标识')).toHaveAccessibleDescription(/标识「feishu-docs」已被占用/),
    )
  })
})

describe('MCP 服务 保存后试连出错', () => {
  it('新建写入成功、随后的试连请求出错：按已保存处理，换成配置面板，原因留在状态行；再保存是修改', async () => {
    const user = await renderPage()
    const creates = recordBodies('POST', /\/api\/mcp-servers$/)
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/asset-search$/)
    server.use(
      http.post('*/api/mcp-servers/:serverId/check', () =>
        HttpResponse.json({ detail: '运行时暂时不可用' }, { status: 502 }),
      ),
    )
    await user.click(within(await openLibrary(user)).getByRole('button', { name: '添加服务' }))
    let panel = sidePanel()
    await user.type(field(panel, '服务名称'), '素材检索')
    await user.type(field(panel, '标识'), 'asset-search')
    await user.type(within(panel).getByLabelText('服务地址'), 'https://assets.example/mcp')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await saveWhenTested(user, panel)

    expect(await within(sidePanel()).findByRole('heading', { name: '配置 MCP' })).toBeVisible()
    panel = sidePanel()
    expect(within(panel).getByRole('status')).toHaveTextContent('运行时暂时不可用')
    expect(within(panel).queryByRole('alert')).toBeNull()
    expect(creates).toHaveLength(1)

    // 再测再存：已经建好，走修改，不会因标识被占用而失败。
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(creates).toHaveLength(1)
    await waitFor(() =>
      expect(within(panel).getByRole('status')).toHaveTextContent('运行时暂时不可用'),
    )

    await user.click(within(panel).getByRole('button', { name: '返回' }))
    const row = await within(sidePanel()).findByRole('button', { name: '编辑 MCP 服务：素材检索' })
    expect(within(row).getByRole('img', { name: '未测试连接' })).toBeInTheDocument()
  })
})

describe('MCP 服务 测试连接', () => {
  it('上次没连上的服务打开就写着原因；再测没通照样不能保存，改对地址测通了才能保存', async () => {
    const user = await renderPage()
    const panel = await openFromLibrary(user, '品牌资产库')
    const status = within(panel).getByRole('status')
    expect(status).toHaveTextContent('域名解析失败')
    expect(within(status).getByRole('img', { name: '连接失败' })).toBeInTheDocument()
    const save = within(panel).getByRole('button', { name: '保存配置' })
    expect(save).toBeDisabled()

    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(status).toHaveTextContent('连不上 brand-assets.invalid'))
    expect(save).toBeDisabled()

    const url = within(panel).getByLabelText('服务地址')
    await user.clear(url)
    await user.type(url, 'https://brand-assets.example/mcp')
    // 改了地址，之前的结果作废。
    expect(status).toHaveTextContent('')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(status).toHaveTextContent(/\d+ ms/))
    expect(save).toBeEnabled()
  })
})

describe('MCP 服务 请求头', () => {
  it('已保存的请求头只显示打码值；不改就不带值，填了新值才带上', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/feishu-docs$/)
    const panel = await openCard(user, '飞书文档')
    const value = within(panel).getByLabelText('请求头的值 1')
    expect(value).toHaveValue('')
    expect(value).toHaveAttribute('placeholder', '••••DEMO')

    const timeout = field(panel, '超时（秒）')
    await user.clear(timeout)
    await user.type(timeout, '60')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(1))
    // 请求头只带名字：试连按服务里同名请求头的原值连，保存沿用原值。
    expect(checks.at(-1)).toEqual({
      headers: [{ name: 'Authorization' }],
      serverId: 'feishu-docs',
      timeoutSeconds: 60,
      transport: 'streamable_http',
      url: 'https://docs.example/mcp',
    })
    expect(patches[0]).toEqual({
      description: '查阅团队文档与创作资料',
      headers: [{ name: 'Authorization' }],
      name: '飞书文档',
      timeoutSeconds: 60,
      transport: 'streamable_http',
      url: 'https://docs.example/mcp',
    })

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '保存配置' })).toBeDisabled(),
    )
    await user.type(within(panel).getByLabelText('请求头的值 1'), 'Bearer new-token')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]?.['headers']).toEqual([{ name: 'Authorization', value: 'Bearer new-token' }])
    await waitFor(() =>
      expect(within(panel).getByLabelText('请求头的值 1')).toHaveAttribute(
        'placeholder',
        '••••oken',
      ),
    )
  })

  it('改了已保存请求头的名字就要重新填值', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const panel = await openCard(user, '飞书文档')
    const name = field(panel, '请求头名称 1')
    await user.clear(name)
    await user.type(name, 'X-Token')
    await user.click(within(panel).getByRole('button', { name: '测试连接' }))
    expect(within(panel).getByLabelText('请求头的值 1')).toHaveAccessibleDescription(
      '请填写请求头的值',
    )
    expect(checks).toHaveLength(0)
  })
})

describe('MCP 服务 挂到 Agent', () => {
  it('管理里点一行挂上，放出全部工具；再点摘下；保存草稿写进 tools', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    await user.click(within(mcpSection()).getByRole('button', { name: '管理 MCP 服务' }))
    const panel = sidePanel()
    expect(within(panel).getByRole('heading', { name: '管理 MCP 服务' })).toBeVisible()
    expect(await within(panel).findByRole('button', { name: '飞书文档' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const gallery = within(panel).getByRole('button', { name: '图库检索' })
    expect(gallery).toHaveAttribute('aria-pressed', 'false')
    await user.click(gallery)
    expect(gallery).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(panel).getByRole('button', { name: '飞书文档' }))
    await user.click(within(panel).getByRole('button', { name: '完成' }))

    const card = within(mcpSection()).getByRole('button', { name: '配置 MCP 服务：图库检索' })
    expect(card).toHaveTextContent('3/3')
    expect(within(card).getByRole('img', { name: '已连接' })).toBeInTheDocument()
    expect(
      within(mcpSection()).queryByRole('button', { name: '配置 MCP 服务：飞书文档' }),
    ).toBeNull()

    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    const tools = (puts[0] as { config: { tools: Body[] } }).config.tools
    expect(tools.filter((tool) => tool['type'] === 'mcp')).toEqual([
      { server: 'image-search', tools: null, type: 'mcp' },
    ])
  })

  it('从当前 Agent 移除：卡片收起，回到管理列表', async () => {
    const user = await renderPage()
    const panel = await openCard(user, '飞书文档')
    await user.click(within(panel).getByRole('button', { name: '从当前 Agent 移除' }))
    expect(within(sidePanel()).getByRole('heading', { name: '管理 MCP 服务' })).toBeVisible()
    expect(within(mcpSection()).getByRole('button', { name: '添加 MCP 服务' })).toBeVisible()
    // 顶部「MCP 服务」此时已选中，再点回到服务库。
    expect(screen.getByRole('tab', { name: 'MCP 服务' })).toHaveAttribute('aria-selected', 'true')
    await openLibrary(user)
  })
})

describe('MCP 服务 选工具', () => {
  it('开关改草稿里的工具名单；最后一个关不掉；全选写成完整名单', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    expect(
      await within(mcpSection()).findByRole('button', { name: '配置 MCP 服务：飞书文档' }),
    ).toHaveTextContent('2/6')
    const panel = await openCard(user, '飞书文档')
    await user.click(within(panel).getByRole('tab', { name: '工具，已启用 2 / 6 个' }))
    const toolSwitch = (name: string) => within(panel).getByRole('switch', { name })
    expect(toolSwitch('search')).toBeChecked()
    expect(toolSwitch('folders')).not.toBeChecked()

    await user.click(toolSwitch('folders'))
    expect(toolSwitch('folders')).toBeChecked()
    expect(
      within(mcpSection()).getByRole('button', { name: '配置 MCP 服务：飞书文档' }),
    ).toHaveTextContent('3/6')

    await user.click(toolSwitch('read'))
    await user.click(toolSwitch('folders'))
    expect(toolSwitch('search')).toHaveAttribute('aria-disabled', 'true')
    await user.click(toolSwitch('search'))
    expect(toolSwitch('search')).toBeChecked()

    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect((puts[0] as { config: { tools: Body[] } }).config.tools).toContainEqual({
      server: 'feishu-docs',
      tools: ['search'],
      type: 'mcp',
    })

    await user.click(within(panel).getByRole('button', { name: '全选' }))
    expect(within(panel).queryByRole('button', { name: '全选' })).toBeNull()
    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect((puts[1] as { config: { tools: Body[] } }).config.tools).toContainEqual({
      server: 'feishu-docs',
      tools: ['search', 'read', 'folders', 'comments', 'create', 'update'],
      type: 'mcp',
    })
  })

  it('没挂到当前 Agent 的服务：工具只能看，开关被拦下', async () => {
    const user = await renderPage()
    const panel = await openFromLibrary(user, '图库检索')
    expect(within(panel).queryByRole('button', { name: '从当前 Agent 移除' })).toBeNull()
    await user.click(within(panel).getByRole('tab', { name: '工具，已启用 0 / 3 个' }))
    const toolSwitch = within(panel).getByRole('switch', { name: 'search_images' })
    expect(toolSwitch).toHaveAttribute('aria-disabled', 'true')
    await user.hover(toolSwitch)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('还没有挂这个服务')
  })
})

describe('MCP 服务 发布', () => {
  it('发布检查指到 MCP 项的问题写在「MCP 服务」一节', async () => {
    const user = await renderPage()
    server.use(
      http.post('*/api/agents/director/versions', () =>
        HttpResponse.json(
          {
            detail: '工具 archive 不在飞书文档最后一次发现的工具里',
            problems: [
              {
                message: '工具 archive 不在飞书文档最后一次发现的工具里',
                path: 'tools[5].tools[0]',
              },
            ],
          },
          { status: 422 },
        ),
      ),
    )
    await user.click(within(editor()).getByRole('button', { name: '发布' }))

    expect(await within(mcpSection()).findByRole('alert')).toHaveTextContent('工具 archive')
    expect(
      within(within(editor()).getByRole('region', { name: '插件' })).queryByRole('alert'),
    ).toBeNull()
  })

  it('挂上还没连通过的服务：发布被拦下，原因写在「MCP 服务」一节', async () => {
    const user = await renderPage()
    const posts = recordBodies('POST', /\/agents\/director\/versions$/)
    await user.click(within(mcpSection()).getByRole('button', { name: '管理 MCP 服务' }))
    const notes = await within(sidePanel()).findByRole('button', { name: '客户笔记' })
    expect(within(notes).getByRole('img', { name: '未测试连接' })).toBeInTheDocument()
    await user.click(notes)
    await user.click(within(sidePanel()).getByRole('button', { name: '完成' }))

    await user.click(within(editor()).getByRole('button', { name: '发布' }))

    expect(await within(mcpSection()).findByRole('alert')).toHaveTextContent(
      'MCP 服务 客户笔记 还没有连通过，先测试连接再发布',
    )
    expect(
      within(within(editor()).getByRole('region', { name: '插件' })).queryByRole('alert'),
    ).toBeNull()
    expect(posts).toHaveLength(1)
  })
})

describe('MCP 服务 删除', () => {
  it('在用的服务删不掉，原因写在面板里；没人用的删掉后回到库', async () => {
    const user = await renderPage()
    let panel = await openFromLibrary(user, '飞书文档')
    await user.click(within(panel).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除服务' }))
    await user.click(within(panel).getByRole('button', { name: '删除' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'MCP 服务 飞书文档 还在被这些 agent 使用：AI 导演（director，草稿与当前版本）',
    )

    await user.click(within(panel).getByRole('button', { name: '返回' }))
    panel = await openFromLibrary(user, '图库检索')
    await user.click(within(panel).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除服务' }))
    await user.click(within(panel).getByRole('button', { name: '删除' }))

    expect(await within(sidePanel()).findByRole('heading', { name: 'MCP 服务' })).toBeVisible()
    await waitFor(() =>
      expect(
        within(sidePanel()).queryByRole('button', { name: '编辑 MCP 服务：图库检索' }),
      ).toBeNull(),
    )
    expect(
      within(sidePanel()).getByRole('button', { name: '编辑 MCP 服务：飞书文档' }),
    ).toBeVisible()
  })
})
