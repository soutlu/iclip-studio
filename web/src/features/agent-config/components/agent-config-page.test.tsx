import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { mockSkillId } from '@/testing/mocks/agent-config'
import { loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { AgentPreviewConversation } from '@/routes/-agent-preview-conversation'
import { AgentConfigPage } from './agent-config-page'

type Body = Record<string, unknown>

function Harness({ initial }: { initial: string | undefined }) {
  const [agentId, setAgentId] = useState(initial)
  return (
    <AgentConfigPage
      agentId={agentId}
      onAgentChange={setAgentId}
      PreviewConversation={AgentPreviewConversation}
    />
  )
}

const renderPage = async (initial?: string) => {
  loginAs(mockGovernor)
  const user = userEvent.setup()
  await renderWithProviders(<Harness initial={initial} />)
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
const section = (name: string) => within(editor()).getByRole('region', { name })
const pluginCards = () =>
  within(section('插件'))
    .queryAllByText(/./, { selector: 'span.truncate' })
    .map((node) => node.textContent)

/** 右栏打开的配置面板。 */
const sidePanel = () => screen.getByRole('region', { name: '配置调整' })

const openPlugins = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(editor()).getByRole('button', { name: '管理插件' }))
  return sidePanel()
}

describe('AgentConfigPage 保存草稿', () => {
  it('整份覆盖草稿：带读到的 lockVersion，没动过的 MCP 项与插件参数原样带回', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    const save = within(editor()).getByRole('button', { name: '保存草稿' })
    expect(save).toBeDisabled()

    const panel = await openPlugins(user)
    // 关了再开回到原位，草稿不算改过。
    await user.click(within(panel).getByRole('switch', { name: '工作区文件' }))
    expect(save).toBeEnabled()
    await user.click(within(panel).getByRole('switch', { name: '工作区文件' }))
    expect(save).toBeDisabled()

    await user.click(within(panel).getByRole('switch', { name: '镜头组表' }))
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(puts).toHaveLength(1))
    const body = puts[0] as { lockVersion: number; config: { tools: Body[] }; skillIds: string[] }
    expect(body.lockVersion).toBe(3)
    expect(body.skillIds).toEqual([
      mockSkillId('director'),
      mockSkillId('storyboard-workflow'),
      mockSkillId('viral-script-remix'),
    ])
    expect(body.config.tools).toContainEqual({
      server: 'feishu-docs',
      tools: ['search', 'read'],
      type: 'mcp',
    })
    expect(body.config.tools).toContainEqual({
      enabled: true,
      parameters: {},
      toolset: 'video_shots',
      type: 'cap',
    })
    await waitFor(() => expect(save).toBeDisabled())
  })

  it('草稿已被别处改过（409）：就地说明，丢掉没保存的修改并重新读取', async () => {
    const user = await renderPage()
    server.use(
      http.put('*/api/agents/director/draft', () =>
        HttpResponse.json({ detail: '草稿已过期' }, { status: 409 }),
      ),
    )
    const panel = await openPlugins(user)
    await user.click(within(panel).getByRole('switch', { name: '镜头组表' }))
    await user.click(within(panel).getByRole('button', { name: '完成' }))
    expect(pluginCards()).toContain('镜头组表')

    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))

    expect(await within(editor()).findByRole('alert')).toHaveTextContent('草稿已被别人修改')
    await waitFor(() => expect(pluginCards()).not.toContain('镜头组表'))
    expect(within(editor()).getByRole('button', { name: '保存草稿' })).toBeDisabled()
  })
})

describe('AgentConfigPage 发布', () => {
  it('缺依赖的插件标红；发布先存草稿再按新的 lockVersion 发布，检查不过的问题写在对应一节；改好后发布出新版本', async () => {
    const user = await renderPage()
    const posts = recordBodies('POST', /\/agents\/director\/versions$/)
    const panel = await openPlugins(user)
    await user.click(within(panel).getByRole('switch', { name: '工作区文件' }))
    // 不连带关掉依赖它的插件，只标出缺的依赖。
    expect(within(panel).getByRole('switch', { name: '视频理解' })).toBeChecked()
    expect(within(panel).getAllByRole('img', { name: '需要同时启用「工作区文件」' })).toHaveLength(
      4,
    )
    await user.click(within(panel).getByRole('button', { name: '返回' }))
    expect(
      within(section('插件')).getAllByRole('img', { name: '需要同时启用「工作区文件」' }),
    ).toHaveLength(4)

    await user.click(within(editor()).getByRole('button', { name: '发布' }))

    const problems = await within(section('插件')).findByRole('alert')
    expect(problems).toHaveTextContent('「视频理解」需要同时启用「工作区文件」')
    expect(within(section('指令')).queryByRole('alert')).toBeNull()
    // 先存的草稿把 lockVersion 加到了 4，发布带的是存好后的值（mock 对不上会答 409）。
    expect(posts).toEqual([{ lockVersion: 4 }])
    expect(within(editor()).getByRole('button', { name: '保存草稿' })).toBeDisabled()

    await user.click(within(await openPlugins(user)).getByRole('switch', { name: '工作区文件' }))
    // 改了草稿，问题收起。
    expect(within(section('插件')).queryByRole('alert')).toBeNull()
    await user.click(within(editor()).getByRole('button', { name: '发布' }))

    await waitFor(() => expect(posts).toHaveLength(2))
    await user.click(within(editor()).getByRole('button', { name: /^查看版本/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitemradio', { name: /^v7，当前版本，治理者/ })).toBeVisible()
    expect(within(menu).getByRole('menuitemradio', { name: /^v6，陈思远/ })).toBeVisible()
  })

  it('还没选模型的 agent 发布：问题写在「指令」一节', async () => {
    const user = await renderPage('cross-border-multilingual')
    expect(within(section('指令')).getByRole('button', { name: '选择模型' })).toBeVisible()

    await user.click(within(editor()).getByRole('button', { name: '发布' }))

    expect(await within(section('指令')).findByRole('alert')).toHaveTextContent('请选择模型')
  })
})

describe('AgentConfigPage 历史版本', () => {
  it('看历史版本只读；恢复把这一版抄回草稿并回到草稿', async () => {
    const user = await renderPage()
    const restores = recordBodies('POST', /\/versions\/[^/]+\/restore$/)
    await user.click(within(editor()).getByRole('button', { name: '查看版本，当前：草稿' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /^v5，/ }))

    expect(
      await within(editor()).findByRole('button', { name: '查看版本，当前：v5' }),
    ).toBeVisible()
    expect(pluginCards()).toEqual(['工作区文件', '视频理解', '导演工程'])
    expect(within(editor()).queryByRole('button', { name: '管理插件' })).toBeNull()
    expect(within(editor()).queryByRole('button', { name: '编辑系统提示词' })).toBeNull()
    expect(within(editor()).queryByRole('button', { name: '保存草稿' })).toBeNull()

    await user.click(within(editor()).getByRole('button', { name: '恢复到草稿' }))

    expect(
      await within(editor()).findByRole('button', { name: '查看版本，当前：草稿' }),
    ).toBeVisible()
    expect(restores).toEqual([{ lockVersion: 3 }])
    expect(pluginCards()).toEqual(['工作区文件', '视频理解', '导演工程'])
    expect(within(editor()).getByRole('button', { name: '管理插件' })).toBeVisible()
    // 恢复已存进草稿，没有要保存的。
    expect(within(editor()).getByRole('button', { name: '保存草稿' })).toBeDisabled()
  })

  it('返回草稿不改任何东西', async () => {
    const user = await renderPage()
    await user.click(within(editor()).getByRole('button', { name: '查看版本，当前：草稿' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /^v4，/ }))
    expect(await within(editor()).findByRole('button', { name: '返回草稿' })).toBeVisible()
    expect(pluginCards()).toEqual(['工作区文件', '视频理解'])

    await user.click(within(editor()).getByRole('button', { name: '返回草稿' }))
    expect(pluginCards()).toHaveLength(5)
  })
})

describe('AgentConfigPage 新建 Agent', () => {
  it('标识只在不合格时提示；后端拦下的保留词写在标识下；创建时带上首页可见，建好后进入它的空配置', async () => {
    const user = await renderPage()
    const creates = recordBodies('POST', /\/api\/agents$/)
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    const page = screen.getByRole('region', { name: '新建 Agent' })
    expect(within(page).queryByText(/标识以小写字母开头/)).toBeNull()

    await user.click(within(page).getByRole('button', { name: '创建并配置' }))
    expect(within(page).getByRole('textbox', { name: '名称' })).toHaveAccessibleDescription(
      '请填写名称',
    )
    await waitFor(() => expect(within(page).getByRole('textbox', { name: '名称' })).toHaveFocus())
    expect(within(page).getByRole('textbox', { name: '标识' })).toHaveAccessibleDescription(
      '请填写标识',
    )

    await user.type(within(page).getByRole('textbox', { name: '名称' }), '海外选品助手')
    await user.type(within(page).getByRole('textbox', { name: '标识' }), 'Overseas_Helper')
    await user.click(within(page).getByRole('button', { name: '创建并配置' }))
    expect(within(page).getByRole('textbox', { name: '标识' })).toHaveAccessibleDescription(
      /标识以小写字母开头/,
    )
    expect(creates).toHaveLength(0)

    await user.clear(within(page).getByRole('textbox', { name: '标识' }))
    await user.type(within(page).getByRole('textbox', { name: '标识' }), 'plugins')
    await user.click(within(page).getByRole('button', { name: '创建并配置' }))
    await waitFor(() =>
      expect(within(page).getByRole('textbox', { name: '标识' })).toHaveAccessibleDescription(
        /不可用/,
      ),
    )

    await user.clear(within(page).getByRole('textbox', { name: '标识' }))
    await user.type(within(page).getByRole('textbox', { name: '标识' }), 'overseas-helper')
    await user.click(within(page).getByRole('switch', { name: '首页可见' }))
    await user.click(within(page).getByRole('button', { name: '创建并配置' }))

    expect(
      await screen.findByRole('button', { name: '切换 Agent，当前：海外选品助手' }),
    ).toBeVisible()
    expect(creates.at(-1)).toEqual({
      description: '',
      id: 'overseas-helper',
      listed: false,
      name: '海外选品助手',
    })
    expect(within(section('指令')).getByRole('button', { name: '选择模型' })).toBeVisible()
  })
})

describe('AgentConfigPage 模型设置', () => {
  it('选模型、思考档位与密钥：换供应商时密钥回到默认，档位只给模型允许的几档', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    await user.click(
      within(section('指令')).getByRole('button', { name: /^模型设置：qwen3.8-flash/ }),
    )
    const panel = screen.getByRole('region', { name: '模型设置' })
    const thinking = () => within(panel).getByRole('radiogroup', { name: '思考档位' })

    expect(within(panel).getByRole('radio', { name: /qwen3.8-flash/ })).toBeChecked()
    expect(within(thinking()).getByRole('radio', { name: /中/ })).toBeChecked()

    await user.click(within(panel).getByRole('button', { name: '密钥：默认' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /创作团队/ }))
    expect(within(panel).getByRole('button', { name: '密钥：创作团队' })).toBeVisible()

    // 不能设档位的模型：档位只剩一个不可选的「默认」。
    await user.click(within(panel).getByRole('radio', { name: /^studio-chat\s?128K$/ }))
    expect(within(thinking()).getByRole('radio', { name: '默认' })).toBeDisabled()
    expect(within(panel).getByRole('button', { name: '密钥：默认' })).toBeVisible()

    // 新模型不允许原来的档位：取它允许的第一档。
    await user.click(within(panel).getByRole('radio', { name: /^studio-chat-long/ }))
    expect(
      within(thinking())
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['🙂极低', '🤯很高'])
    expect(within(thinking()).getByRole('radio', { name: /极低/ })).toBeChecked()
    await user.click(within(thinking()).getByRole('radio', { name: /很高/ }))

    await user.click(within(panel).getByRole('button', { name: '完成' }))
    expect(
      within(section('指令')).getByRole('button', {
        name: '模型设置：studio-chat-long，思考：很高',
      }),
    ).toBeVisible()
    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect((puts[0] as { config: Body }).config['model']).toEqual({
      credential_id: null,
      name: 'studio-chat-long',
      provider: 'team-models',
      settings: { thinking: 'xhigh' },
    })
  })
})

describe('AgentConfigPage 子 Agent', () => {
  it('只能选发布过、没归档、自己没有子 Agent 的；绑定的时限与次数不填就是不限，填错就地提示', async () => {
    const user = await renderPage()
    const puts = recordBodies('PUT', /\/agents\/director\/draft$/)
    await user.click(
      within(section('子 Agent')).getByRole('button', { name: '配置子 Agent：拆解助手' }),
    )
    const panel = sidePanel()

    // 从卡片点进来先展开它。
    expect(within(panel).getByRole('textbox', { name: '拆解助手的调用时限（秒）' })).toHaveValue(
      '300',
    )
    expect(within(panel).queryByRole('switch', { name: '旧版文案助手' })).toBeNull()
    const unpublished = within(panel).getByRole('switch', {
      name: '跨境电商多语种短视频批量生成助手',
    })
    expect(unpublished).toHaveAttribute('aria-disabled', 'true')
    await user.hover(unpublished)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('还没有发布')
    await user.unhover(unpublished)
    await user.click(unpublished)
    expect(unpublished).not.toBeChecked()

    await user.click(within(panel).getByRole('switch', { name: '分镜助手' }))
    const timeout = within(panel).getByRole('textbox', { name: '分镜助手的调用时限（秒）' })
    expect(timeout).toHaveValue('')
    await user.type(timeout, '0')
    expect(timeout).toHaveAccessibleDescription('请填大于 0 的秒数')
    await user.clear(timeout)
    await user.type(timeout, '120')
    expect(timeout).not.toHaveAccessibleDescription()
    await user.click(within(panel).getByRole('button', { name: '完成' }))

    expect(
      within(section('子 Agent')).getByRole('button', { name: '配置子 Agent：分镜助手' }),
    ).toHaveTextContent('120s')
    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect((puts[0] as { config: { subagents: Body[] } }).config.subagents).toEqual([
      { agent: 'breakdown-helper', max_calls: 3, timeout_seconds: 300 },
      { agent: 'storyboard-helper', timeout_seconds: 120 },
    ])
  })

  it('正被别人用作子 Agent 的 agent 不能再添加子 Agent', async () => {
    const user = await renderPage('breakdown-helper')
    // 节标题旁的「+」与空节里的添加卡都被拦下。
    const adds = within(section('子 Agent')).getAllByRole('button', { name: '添加子 Agent' })
    expect(adds).toHaveLength(2)
    for (const add of adds) expect(add).toHaveAttribute('aria-disabled', 'true')
    await user.click(adds[1] as HTMLElement)
    expect(screen.queryByRole('region', { name: '配置调整' })).toBeNull()
    await user.hover(adds[0] as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('正被用作子 Agent')
  })
})
