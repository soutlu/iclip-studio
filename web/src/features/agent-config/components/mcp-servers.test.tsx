import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { McpServerOut } from '@/shared/api/generated/types.gen'
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

const patchMock = (id: string, body: Body) =>
  fetch(`http://localhost/api/mcp-servers/${id}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

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
const status = (panel: HTMLElement) => within(panel).getByRole('status')
const button = (panel: HTMLElement, name: string) => within(panel).getByRole('button', { name })

const editIdentity = async (user: User, panel: HTMLElement) => {
  await user.click(button(panel, '编辑服务名称与地址'))
  return within(panel).getByLabelText('服务地址')
}

const saveWhenTested = async (user: User, panel: HTMLElement) => {
  const save = button(panel, '保存配置')
  await waitFor(() => expect(save).toBeEnabled())
  await user.click(save)
}

const toolState = (panel: HTMLElement, tool: string, state: '允许' | '要求审批' | '关闭') =>
  within(within(panel).getByRole('radiogroup', { name: tool })).getByRole('radio', {
    name: state,
  })

const savedTools = async (user: User, puts: Body[], count: number) => {
  await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))
  await waitFor(() => expect(puts).toHaveLength(count))
  return (puts[count - 1] as { config: { tools: Body[] } }).config.tools.filter(
    (tool) => tool['type'] === 'mcp',
  )
}

describe('MCP 服务 添加', () => {
  it('共用请求头：测试通过才能保存；保存后服务出现在库里，标题换成配置', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const creates = recordBodies('POST', /\/api\/mcp-servers$/)
    const library = await openLibrary(user)
    await user.click(within(library).getByRole('button', { name: '添加服务' }))
    const panel = sidePanel()
    expect(within(panel).getByRole('heading', { name: '添加 MCP 服务' })).toBeVisible()
    expect(within(panel).getByText('暂无工具，保存并测试连接后列出')).toBeVisible()
    expect(button(panel, '保存配置')).toBeDisabled()

    await user.click(button(panel, '测试连接'))
    expect(field(panel, '服务名称')).toHaveAccessibleDescription('请填写服务名称')
    expect(field(panel, '标识')).toHaveAccessibleDescription('请填写标识')
    expect(checks).toHaveLength(0)

    await user.type(field(panel, '服务名称'), '素材检索')
    await user.type(field(panel, '标识'), 'asset-search')
    await user.type(within(panel).getByLabelText('服务地址'), 'https://assets.example/mcp')
    await user.click(within(panel).getByRole('radio', { name: 'SSE' }))
    await user.click(button(panel, '添加请求头'))
    await user.type(field(panel, '请求头名称 1'), 'X-Api-Key')
    await user.type(within(panel).getByLabelText('请求头的值 1'), 'secret-1234')
    await user.click(button(panel, '测试连接'))

    await waitFor(() => expect(status(panel)).toHaveTextContent(/\d+ ms/))
    expect(checks).toEqual([
      {
        authMode: 'shared',
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
        authMode: 'shared',
        description: '',
        headers: [{ name: 'X-Api-Key', value: 'secret-1234' }],
        id: 'asset-search',
        name: '素材检索',
        timeoutSeconds: 30,
        transport: 'sse',
        url: 'https://assets.example/mcp',
      },
    ])
    const saved = sidePanel()
    expect(status(saved)).toHaveTextContent(/\d+ ms/)
    expect(button(saved, '保存配置')).toBeDisabled()
    expect(within(saved).getByText('X-Api-Key')).toBeVisible()
    expect(within(saved).getByText('••••1234')).toBeVisible()

    await user.click(button(saved, '返回'))
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
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)

    await waitFor(() =>
      expect(field(panel, '标识')).toHaveAccessibleDescription(/标识「feishu-docs」已被占用/),
    )
  })

  it('使用自有账户：不用测试就能保存，保存前不发试连；保存后才能测试，未连接时显示原因', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const creates = recordBodies('POST', /\/api\/mcp-servers$/)
    await user.click(within(await openLibrary(user)).getByRole('button', { name: '添加服务' }))
    let panel = sidePanel()
    await user.type(field(panel, '服务名称'), '问卷平台')
    await user.type(field(panel, '标识'), 'survey')
    await user.type(within(panel).getByLabelText('服务地址'), 'https://survey.example/mcp')
    await user.click(within(panel).getByRole('switch', { name: '使用自有账户' }))

    const test = button(panel, '测试连接')
    expect(test).toHaveAttribute('aria-disabled', 'true')
    await user.hover(test)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('请先点击「保存配置」，再测试连接')
    await user.click(test)
    expect(checks).toHaveLength(0)

    await user.click(button(panel, '保存配置'))
    expect(await within(sidePanel()).findByRole('heading', { name: '配置 MCP' })).toBeVisible()
    expect(creates[0]).toMatchObject({ authMode: 'per_user', id: 'survey' })
    panel = sidePanel()
    expect(within(panel).getByText('暂无工具，请先点击「测试连接」')).toBeVisible()
    expect(status(panel)).toHaveTextContent('')
    expect(button(panel, '保存配置')).toBeDisabled()

    await user.click(button(panel, '测试连接'))
    await waitFor(() =>
      expect(status(panel)).toHaveTextContent('你还没有连接 问卷平台，请先连接再测试'),
    )
    expect(checks).toHaveLength(0)
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
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)

    expect(await within(sidePanel()).findByRole('heading', { name: '配置 MCP' })).toBeVisible()
    panel = sidePanel()
    expect(status(panel)).toHaveTextContent('运行时暂时不可用')
    expect(within(panel).queryByRole('alert')).toBeNull()
    expect(creates).toHaveLength(1)

    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(creates).toHaveLength(1)
    await waitFor(() => expect(status(panel)).toHaveTextContent('运行时暂时不可用'))

    await user.click(button(panel, '返回'))
    const row = await within(sidePanel()).findByRole('button', { name: '编辑 MCP 服务：素材检索' })
    expect(within(row).getByRole('img', { name: '未测试连接' })).toBeInTheDocument()
  })
})

describe('MCP 服务 测试连接', () => {
  it('上次没连上的服务打开就写着原因；再测没通照样不能保存，改对地址测通了才能保存', async () => {
    const user = await renderPage()
    const panel = await openFromLibrary(user, '品牌资产库')
    expect(status(panel)).toHaveTextContent('域名解析失败')
    expect(within(status(panel)).getByRole('img', { name: '连接失败' })).toBeInTheDocument()
    const save = button(panel, '保存配置')
    expect(save).toBeDisabled()

    await user.click(button(panel, '测试连接'))
    await waitFor(() => expect(status(panel)).toHaveTextContent('连不上 brand-assets.invalid'))
    expect(save).toBeDisabled()

    const url = await editIdentity(user, panel)
    await user.clear(url)
    await user.type(url, 'https://brand-assets.example/mcp')
    expect(status(panel)).toHaveTextContent('')
    await user.click(button(panel, '测试连接'))
    await waitFor(() => expect(status(panel)).toHaveTextContent(/\d+ ms/))
    expect(save).toBeEnabled()
  })

  it('使用自有账户的服务：连接已失效时显示服务给的原因', async () => {
    server.use(
      http.post('*/api/mcp-servers/:serverId/check', () =>
        HttpResponse.json(
          { code: 'mcp_reconnect_required', detail: '你在 PickFu 的连接已失效，请重新连接' },
          { status: 409 },
        ),
      ),
    )
    const user = await renderPage()
    const panel = await openFromLibrary(user, 'PickFu')
    await user.click(button(panel, '测试连接'))
    await waitFor(() =>
      expect(status(panel)).toHaveTextContent('你在 PickFu 的连接已失效，请重新连接'),
    )
  })
})

describe('MCP 服务 名称与地址', () => {
  it('头部点编辑才换成表单；地址改了才随保存带上，重复时原因写在底部；保存后回到头部', async () => {
    const user = await renderPage()
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/feishu-docs$/)
    const panel = await openCard(user, '飞书文档')
    expect(within(panel).queryByRole('textbox', { name: '服务地址' })).toBeNull()
    expect(within(panel).getByText('https://docs.example/mcp')).toBeVisible()
    expect(status(panel)).toHaveTextContent('142 ms')

    const url = await editIdentity(user, panel)
    expect(url).toHaveValue('https://docs.example/mcp')
    expect(field(panel, '标识')).toHaveAttribute('readonly')
    await user.clear(url)
    await user.type(url, 'https://gallery.example/sse')
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      '这个地址已经登记过：图库检索',
    )
    expect(patches.at(-1)?.['url']).toBe('https://gallery.example/sse')

    await user.clear(url)
    await user.type(url, 'https://docs2.example/mcp')
    await user.type(field(panel, '服务名称'), '（团队）')
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]).toMatchObject({ name: '飞书文档（团队）', url: 'https://docs2.example/mcp' })
    await waitFor(() =>
      expect(within(panel).queryByRole('textbox', { name: '服务地址' })).toBeNull(),
    )
    expect(within(panel).getByText('飞书文档（团队）')).toBeVisible()
    expect(within(panel).getByText('https://docs2.example/mcp')).toBeVisible()
  })

  it('新建时地址已登记过：原因写在底部，不写在标识下面', async () => {
    const user = await renderPage()
    await user.click(within(await openLibrary(user)).getByRole('button', { name: '添加服务' }))
    const panel = sidePanel()
    await user.type(field(panel, '服务名称'), '另一个飞书')
    await user.type(field(panel, '标识'), 'feishu-docs-2')
    await user.type(within(panel).getByLabelText('服务地址'), 'https://docs.example/mcp')
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      '这个地址已经登记过：飞书文档',
    )
    expect(field(panel, '标识')).not.toHaveAccessibleDescription()
  })
})

describe('MCP 服务 超时', () => {
  it('四档可选，选中的档随试连与保存带上', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/feishu-docs$/)
    const panel = await openCard(user, '飞书文档')
    const timeout = within(panel).getByRole('radiogroup', { name: '超时' })
    expect(
      within(timeout)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['10 秒', '30 秒', '60 秒', '120 秒'])
    expect(within(timeout).getByRole('radio', { name: '30 秒' })).toBeChecked()

    await user.click(within(timeout).getByRole('radio', { name: '120 秒' }))
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(checks.at(-1)?.['timeoutSeconds']).toBe(120)
    expect(patches[0]?.['timeoutSeconds']).toBe(120)
  })

  it('以前保存的数值不在四档里：原样显示成多出的一档，改选别的档后这一档消失', async () => {
    await patchMock('feishu-docs', { timeoutSeconds: 45 })
    const user = await renderPage()
    const panel = await openCard(user, '飞书文档')
    const timeout = within(panel).getByRole('radiogroup', { name: '超时' })
    expect(
      within(timeout)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['10 秒', '30 秒', '45 秒', '60 秒', '120 秒'])
    expect(within(timeout).getByRole('radio', { name: '45 秒' })).toBeChecked()

    await user.click(within(timeout).getByRole('radio', { name: '60 秒' }))
    expect(within(timeout).queryByRole('radio', { name: '45 秒' })).toBeNull()
    expect(within(timeout).getByRole('radio', { name: '60 秒' })).toBeChecked()
  })
})

describe('MCP 服务 请求头', () => {
  it('已保存的请求头只显示打码值；不改就不带值，在行里编辑填了新值才带上', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/feishu-docs$/)
    const panel = await openCard(user, '飞书文档')
    expect(within(panel).getByText('Authorization')).toBeVisible()
    expect(within(panel).getByText('••••DEMO')).toBeVisible()
    expect(within(panel).queryByLabelText('请求头的值 1')).toBeNull()

    await user.click(within(panel).getByRole('radio', { name: '60 秒' }))
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(checks.at(-1)).toEqual({
      authMode: 'shared',
      headers: [{ name: 'Authorization' }],
      serverId: 'feishu-docs',
      timeoutSeconds: 60,
      transport: 'streamable_http',
      url: 'https://docs.example/mcp',
    })
    expect(patches[0]).toEqual({
      authMode: 'shared',
      description: '查阅团队文档与创作资料',
      headers: [{ name: 'Authorization' }],
      name: '飞书文档',
      timeoutSeconds: 60,
      transport: 'streamable_http',
    })

    await waitFor(() => expect(button(panel, '保存配置')).toBeDisabled())
    await user.click(button(panel, '编辑请求头 Authorization'))
    const value = within(panel).getByLabelText('请求头的值 1')
    expect(value).toHaveValue('')
    expect(value).toHaveAttribute('placeholder', '••••DEMO')
    await user.type(value, 'Bearer new-token')
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]?.['headers']).toEqual([{ name: 'Authorization', value: 'Bearer new-token' }])
    expect(await within(panel).findByText('••••oken')).toBeVisible()
  })

  it('改了已保存请求头的名字就要重新填值；移除后保存不再带它', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/feishu-docs$/)
    const panel = await openCard(user, '飞书文档')
    await user.click(button(panel, '编辑请求头 Authorization'))
    const name = field(panel, '请求头名称 1')
    await user.clear(name)
    await user.type(name, 'X-Token')
    await user.click(button(panel, '测试连接'))
    expect(within(panel).getByLabelText('请求头的值 1')).toHaveAccessibleDescription(
      '请填写请求头的值',
    )
    expect(checks).toHaveLength(0)

    await user.click(button(panel, '移除请求头 1'))
    await user.click(button(panel, '测试连接'))
    await saveWhenTested(user, panel)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]?.['headers']).toEqual([])
  })
})

describe('MCP 服务 使用自有账户', () => {
  it('已保存的服务：有改动时不能测试；保存只发改动，不带权限', async () => {
    const user = await renderPage()
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/pickfu$/)
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const panel = await openFromLibrary(user, 'PickFu')
    expect(within(panel).getByRole('switch', { name: '使用自有账户' })).toBeChecked()
    expect(button(panel, '测试连接')).not.toHaveAttribute('aria-disabled')
    expect(button(panel, '保存配置')).toBeDisabled()

    await user.click(within(panel).getByRole('radio', { name: '60 秒' }))
    expect(button(panel, '测试连接')).toHaveAttribute('aria-disabled', 'true')
    await user.click(button(panel, '保存配置'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({
      authMode: 'per_user',
      description: '消费者调研',
      headers: [{ name: 'X-PickFu-Team' }],
      name: 'PickFu',
      timeoutSeconds: 60,
      transport: 'streamable_http',
    })
    await waitFor(() => expect(button(panel, '测试连接')).not.toHaveAttribute('aria-disabled'))
    expect(checks).toHaveLength(0)
  })

  it('关掉开关后按共用请求头试连，试连请求写明 shared', async () => {
    const user = await renderPage()
    const checks = recordBodies('POST', /\/api\/mcp-servers\/check$/)
    const panel = await openFromLibrary(user, 'PickFu')
    await user.click(within(panel).getByRole('switch', { name: '使用自有账户' }))
    expect(button(panel, '测试连接')).not.toHaveAttribute('aria-disabled')
    await user.click(button(panel, '测试连接'))
    await waitFor(() => expect(checks).toHaveLength(1))
    expect(checks[0]).toMatchObject({ authMode: 'shared', serverId: 'pickfu' })
  })
})

describe('MCP 服务 权限', () => {
  it('测试通过后列出服务公布的权限；关掉的与加上的写进 oauthScopes；影响已连接的人时先确认', async () => {
    const user = await renderPage()
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/pickfu$/)
    const panel = await openFromLibrary(user, 'PickFu')
    expect(within(panel).queryByRole('region', { name: '权限' })).toBeNull()

    await user.click(button(panel, '测试连接'))
    const scopes = await within(panel).findByRole('region', { name: '权限' })
    expect(
      within(scopes)
        .getAllByRole('switch')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['read', 'write', 'spend'])
    expect(within(scopes).getByRole('switch', { name: 'spend' })).toBeChecked()

    await user.click(within(scopes).getByRole('switch', { name: 'spend' }))
    await user.click(within(scopes).getByRole('button', { name: '添加权限' }))
    const input = within(scopes).getByRole('textbox', { name: '新权限名称' })
    await user.type(input, 'read{Enter}')
    expect(input).toHaveAccessibleDescription('这个权限已在列表里')
    await user.clear(input)
    await user.type(input, 'admin{Enter}')
    expect(within(scopes).getByRole('switch', { name: 'admin' })).toBeChecked()

    await user.click(button(panel, '保存配置'))
    const dialog = await screen.findByRole('dialog', { name: '保存确认' })
    expect(dialog).toHaveTextContent('保存后，已连接的 3 人需要重新连接')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.['oauthScopes']).toEqual(['read', 'write', 'admin'])
    expect(patches[0]).not.toHaveProperty('confirmReconnect')

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '保存确认' })).toBeNull()
    expect(button(panel, '保存配置')).toHaveFocus()
    expect(patches).toHaveLength(1)

    await user.click(button(panel, '保存配置'))
    await user.click(
      within(await screen.findByRole('dialog', { name: '保存确认' })).getByRole('button', {
        name: '保存',
      }),
    )
    await waitFor(() => expect(patches).toHaveLength(3))
    expect(patches[2]).toMatchObject({
      confirmReconnect: true,
      oauthScopes: ['read', 'write', 'admin'],
    })
    await waitFor(() => expect(button(panel, '保存配置')).toBeDisabled())
    expect(screen.queryByRole('dialog', { name: '保存确认' })).toBeNull()
  })
})

describe('MCP 服务 客户端', () => {
  it('服务要求填客户端：给出回调地址可复制；填了客户端 ID 与密钥才随保存带上', async () => {
    const user = await renderPage()
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/user-insights$/)
    const panel = await openFromLibrary(user, '用户洞察')
    expect(within(panel).getByRole('alert')).toHaveTextContent('该服务不支持自动注册，无法连接')
    const callback = await within(panel).findByLabelText('回调地址')
    expect(callback).toHaveValue('https://iclip.example/mcp/callback')
    await user.click(button(panel, '复制回调地址'))
    await expect(navigator.clipboard.readText()).resolves.toBe('https://iclip.example/mcp/callback')

    await user.type(field(panel, '客户端 ID'), 'iclip-app')
    await user.type(within(panel).getByLabelText('客户端密钥'), 'client-secret-9876')
    await user.click(button(panel, '保存配置'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]?.['oauthClient']).toEqual({
      clientId: 'iclip-app',
      clientSecret: 'client-secret-9876',
    })
    await waitFor(() =>
      expect(within(panel).getByLabelText('客户端密钥')).toHaveAttribute('placeholder', '••••9876'),
    )
    expect(within(panel).queryByRole('alert')).toBeNull()
  })

  it('已填过客户端：密钥留空就沿用；只改别的设置不带客户端；没配回调地址时不显示那一行', async () => {
    server.use(
      http.get(/\/api\/mcp-servers:callback-url$/, () => HttpResponse.json({ callbackUrl: null })),
    )
    await patchMock('user-insights', {
      oauthClient: { clientId: 'iclip-app', clientSecret: 'client-secret-9876' },
    })
    const user = await renderPage()
    const patches = recordBodies('PATCH', /\/api\/mcp-servers\/user-insights$/)
    const panel = await openFromLibrary(user, '用户洞察')
    expect(field(panel, '客户端 ID')).toHaveValue('iclip-app')
    expect(within(panel).getByLabelText('客户端密钥')).toHaveValue('')
    await waitFor(() => expect(within(panel).queryByLabelText('回调地址')).toBeNull())

    await user.click(within(panel).getByRole('radio', { name: '60 秒' }))
    await user.click(button(panel, '保存配置'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).not.toHaveProperty('oauthClient')

    await user.type(field(panel, '客户端 ID'), '-2')
    await user.click(button(panel, '保存配置'))
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]?.['oauthClient']).toEqual({ clientId: 'iclip-app-2' })
  })
})

describe('MCP 服务 挂到 Agent', () => {
  it('管理里点一行挂上，工具全部关闭；再点摘下；保存草稿写进 tools', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    await user.click(within(mcpSection()).getByRole('button', { name: '管理 MCP 服务' }))
    const panel = sidePanel()
    expect(within(panel).getByRole('heading', { name: '管理 MCP 服务' })).toBeVisible()
    expect(await within(panel).findByRole('switch', { name: '飞书文档' })).toBeChecked()
    const gallery = within(panel).getByRole('switch', { name: '图库检索' })
    expect(gallery).not.toBeChecked()
    await user.click(gallery)
    expect(gallery).toBeChecked()
    await user.click(within(panel).getByRole('switch', { name: '飞书文档' }))
    await user.click(within(panel).getByRole('button', { name: '完成' }))

    const card = within(mcpSection()).getByRole('button', { name: '配置 MCP 服务：图库检索' })
    expect(card).toHaveTextContent('0/3')
    expect(within(card).getByRole('img', { name: '已连接' })).toBeInTheDocument()
    expect(
      within(mcpSection()).queryByRole('button', { name: '配置 MCP 服务：飞书文档' }),
    ).toBeNull()

    expect(await savedTools(user, puts, 1)).toEqual([
      { approval_tools: [], server: 'image-search', tools: [], type: 'mcp' },
    ])
    const tools = await openCard(user, '图库检索')
    expect(toolState(tools, 'search_images', '关闭')).toBeChecked()
  })

  it('已停用且没挂上的服务开关不可用', async () => {
    const stopped: McpServerOut = {
      authMode: 'shared',
      createdAt: '2026-11-01T00:00:00Z',
      createdBy: mockGovernor.id,
      description: '查询客户跟进记录',
      enabled: false,
      headers: [],
      id: 'crm-notes',
      lastCheck: null,
      name: '客户笔记',
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
      tools: null,
      transport: 'streamable_http',
      updatedAt: '2026-11-01T00:00:00Z',
      updatedBy: mockGovernor.id,
      url: 'https://crm.example/mcp',
      usedBy: [],
    }
    server.use(http.get('*/api/mcp-servers', () => HttpResponse.json({ items: [stopped] })))
    const user = await renderPage()
    await user.click(within(mcpSection()).getByRole('button', { name: '管理 MCP 服务' }))
    const toggle = await within(sidePanel()).findByRole('switch', { name: '客户笔记' })
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
  })

  it('从当前 Agent 移除：卡片收起，回到管理列表', async () => {
    const user = await renderPage()
    const panel = await openCard(user, '飞书文档')
    await user.click(button(panel, '从当前 Agent 移除'))
    expect(within(sidePanel()).getByRole('heading', { name: '管理 MCP 服务' })).toBeVisible()
    expect(within(mcpSection()).getByRole('button', { name: '添加 MCP 服务' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'MCP 服务' })).toHaveAttribute('aria-selected', 'true')
    await openLibrary(user)
  })
})

describe('MCP 服务 工具', () => {
  it('允许、要求审批、关闭写成草稿里的 tools 与 approval_tools；计数跟着变；全部设为一次改完', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    const card = () => within(mcpSection()).getByRole('button', { name: '配置 MCP 服务：飞书文档' })
    expect(
      await within(mcpSection()).findByRole('button', { name: '配置 MCP 服务：飞书文档' }),
    ).toHaveTextContent('2/6')
    const panel = await openCard(user, '飞书文档')
    expect(within(panel).getByRole('img', { name: '已放给 Agent 2 / 6 个工具' })).toBeVisible()
    expect(toolState(panel, '搜索文档', '允许')).toBeChecked()
    expect(toolState(panel, 'folders', '关闭')).toBeChecked()

    await user.click(toolState(panel, 'folders', '要求审批'))
    await user.click(toolState(panel, '读取文档', '关闭'))
    expect(toolState(panel, 'folders', '要求审批')).toBeChecked()
    expect(card()).toHaveTextContent('2/6')
    await user.click(toolState(panel, '搜索文档', '关闭'))
    expect(card()).toHaveTextContent('1/6')
    expect(await savedTools(user, puts, 1)).toEqual([
      { approval_tools: ['folders'], server: 'feishu-docs', tools: ['folders'], type: 'mcp' },
    ])

    await user.click(button(panel, '全部设为'))
    await user.click(await screen.findByRole('menuitem', { name: '要求审批' }))
    expect(card()).toHaveTextContent('6/6')
    const all = ['search', 'read', 'folders', 'comments', 'create', 'update']
    expect(await savedTools(user, puts, 2)).toEqual([
      { approval_tools: all, server: 'feishu-docs', tools: all, type: 'mcp' },
    ])

    await user.click(button(panel, '全部设为'))
    await user.click(await screen.findByRole('menuitem', { name: '关闭' }))
    expect(card()).toHaveTextContent('0/6')
    expect(await savedTools(user, puts, 3)).toEqual([
      { approval_tools: [], server: 'feishu-docs', tools: [], type: 'mcp' },
    ])
  })

  it('三档可用键盘操作：方向键移到下一档，空格选中', async () => {
    const user = await renderPage()
    const panel = await openCard(user, '飞书文档')
    toolState(panel, '搜索文档', '允许').focus()
    await user.keyboard('{ArrowRight}')
    expect(toolState(panel, '搜索文档', '要求审批')).toHaveFocus()
    await user.keyboard(' ')
    expect(toolState(panel, '搜索文档', '要求审批')).toBeChecked()
  })

  it('没挂到当前 Agent 的服务：工具只能看，说明写着先添加', async () => {
    const user = await renderPage()
    const panel = await openFromLibrary(user, '图库检索')
    expect(within(panel).queryByRole('button', { name: '从当前 Agent 移除' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: '全部设为' })).toBeNull()
    expect(within(panel).getByText(/当前 Agent 还没有挂这个服务/)).toBeVisible()
    expect(toolState(panel, 'search_images', '关闭')).toBeChecked()
    expect(toolState(panel, 'search_images', '允许')).toBeDisabled()
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
    const notes = await within(sidePanel()).findByRole('switch', { name: '客户笔记' })
    const card = notes.closest('li') as HTMLElement
    expect(within(card).getByRole('img', { name: '未测试连接' })).toBeInTheDocument()
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
    await user.click(button(panel, '更多操作'))
    await user.click(await screen.findByRole('menuitem', { name: '删除服务' }))
    await user.click(button(panel, '删除'))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'MCP 服务 飞书文档 还在被这些 agent 使用：AI 导演（director，草稿与当前版本）',
    )

    await user.click(button(panel, '返回'))
    panel = await openFromLibrary(user, '图库检索')
    await user.click(button(panel, '更多操作'))
    await user.click(await screen.findByRole('menuitem', { name: '删除服务' }))
    await user.click(button(panel, '删除'))

    expect(await within(sidePanel()).findByRole('heading', { name: 'MCP 服务' })).toBeVisible()
    await waitFor(() =>
      expect(
        within(sidePanel()).queryByRole('button', { name: '编辑 MCP 服务：图库检索' }),
      ).toBeNull(),
    )
    expect(button(sidePanel(), '编辑 MCP 服务：飞书文档')).toBeVisible()
  })
})
