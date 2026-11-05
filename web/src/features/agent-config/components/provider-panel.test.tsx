import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { AgentPreviewConversation } from '@/routes/-agent-preview-conversation'
import { PERMISSION } from '@/shared/auth'
import { loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { AgentConfigPage } from './agent-config-page'

type Body = Record<string, unknown>
type Sent = { method: string; path: string; body: Body | null }
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

const renderPage = async (permissions = mockGovernor.permissions) => {
  loginAs(mockGovernor, { permissions })
  const user = userEvent.setup()
  await renderWithProviders(<Harness />)
  await screen.findByRole('button', { name: /^切换 Agent，当前：/ })
  return user
}

const recordWrites = () => {
  const sent: Sent[] = []
  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' || !/\/(model-providers|default-models)/.test(pathname)) return
    const entry: Sent = { body: null, method: request.method, path: decodeURI(pathname) }
    sent.push(entry)
    void request
      .clone()
      .text()
      .then((text) => {
        entry.body = text === '' ? null : (JSON.parse(text) as Body)
      })
  })
  return sent
}

const panel = () => screen.getByRole('region', { name: '模型与供应商' })

const openProviders = async (user: User) => {
  await user.click(screen.getByRole('tab', { name: '模型与供应商' }))
  return within(panel()).findByRole('textbox', { name: '供应商显示名' })
}

const formNamed = (name: string) => within(within(panel()).getByRole('form', { name }))

const createProviderFor = async (
  user: User,
  declaration: string | null,
  label: string,
  name: string,
) => {
  await user.click(within(panel()).getByRole('button', { name: '添加供应商' }))
  const form = formNamed('添加供应商')
  expect(form.queryByLabelText('API Key')).toBeNull()
  expect(form.getByRole('button', { name: '接入方式：阿里云百炼' })).toBeVisible()
  if (declaration !== null) {
    await user.click(form.getByRole('button', { name: /^接入方式：/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: declaration }))
    expect(form.getByRole('button', { name: `接入方式：${declaration}` })).toBeVisible()
  }
  await user.type(form.getByLabelText('显示名'), label)
  await user.type(form.getByLabelText('引用名'), name)
  await user.click(form.getByRole('button', { name: '添加' }))
  return within(await within(panel()).findByRole('form', { name: '添加密钥' }))
}

const card = (label: string) => within(panel()).getByRole('button', { name: `供应商：${label}` })

const rowOf = (control: HTMLElement) => {
  const row = control.closest('li')
  if (row === null) throw new Error('控件不在列表行里')
  return within(row)
}

describe('模型与供应商 入口', () => {
  it('持 model:manage 才有这一页', async () => {
    await renderPage(mockGovernor.permissions.filter((item) => item !== PERMISSION.modelManage))
    expect(screen.getByRole('tab', { name: '插件' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: '模型与供应商' })).toBeNull()
  })

  it('打开后列出供应商卡片，默认选中第一个并显示默认密钥的接口地址与在用的 agent', async () => {
    const user = await renderPage()
    await openProviders(user)
    expect(card('阿里云百炼')).toHaveAttribute('aria-current', 'true')
    expect(card('团队模型服务')).toBeVisible()
    expect(within(panel()).getByRole('textbox', { name: '供应商显示名' })).toHaveValue('阿里云百炼')
    expect(
      within(panel()).getByText('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    ).toBeVisible()
    expect(
      within(panel())
        .getAllByRole('img', { name: /^在用：/ })
        .map((node) => node.getAttribute('aria-label')),
    ).toContain('在用：拆解助手、AI 导演、旧版文案助手、分镜助手')
  })
})

describe('添加供应商', () => {
  const createProvider = (user: User) => createProviderFor(user, null, '海外模型服务', 'overseas')

  const keyCount = (label: string) =>
    within(card(label))
      .getAllByText(/^\d+$/)
      .map((node) => node.textContent)

  it('建好供应商后选中它，直接展开「添加密钥」并聚焦第一个字段；试连通过后存上第一把密钥', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    const keyForm = await createProvider(user)

    expect(sent).toEqual([
      {
        body: { label: '海外模型服务', name: 'overseas', provider: 'bailian' },
        method: 'POST',
        path: '/api/model-providers',
      },
    ])
    expect(card('海外模型服务')).toHaveAttribute('aria-current', 'true')
    expect(within(panel()).getByRole('textbox', { name: '供应商显示名' })).toHaveValue(
      '海外模型服务',
    )
    expect(keyCount('海外模型服务')).toEqual(['2', '0'])
    expect(keyForm.getByLabelText('名称')).toHaveFocus()

    await user.type(keyForm.getByLabelText('名称'), '海外账号')
    await user.type(keyForm.getByLabelText('API Key'), 'sk-overseas-1234')
    await user.click(keyForm.getByRole('button', { name: '试连' }))
    expect(await keyForm.findByText('236 ms')).toBeVisible()
    await user.click(keyForm.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(within(panel()).queryByRole('form')).toBeNull())
    expect(sent.at(-1)).toEqual({
      body: {
        fields: {
          api_key: 'sk-overseas-1234',
          base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        },
        name: '海外账号',
      },
      method: 'POST',
      path: expect.stringMatching(/^\/api\/model-providers\/[\w-]+\/credentials$/),
    })
    const key = within(panel()).getByText('海外账号')
    expect(rowOf(key).getByText('••••1234')).toBeVisible()
    expect(rowOf(key).getByText('默认')).toBeVisible()
  })

  it('新供应商的密钥试连没通过只是提示，照样能保存；取消后供应商留在列表里，没有密钥', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    const keyForm = await createProvider(user)
    await user.type(keyForm.getByLabelText('名称'), '海外账号')
    await user.type(keyForm.getByLabelText('API Key'), 'sk-invalid-9999')
    await user.click(keyForm.getByRole('button', { name: '试连' }))
    expect(await keyForm.findByText('接口返回 401，API Key 无效')).toBeVisible()
    expect(keyForm.getByRole('button', { name: '保存' })).toBeEnabled()

    await user.click(keyForm.getByRole('button', { name: '取消' }))
    expect(within(panel()).queryByRole('form')).toBeNull()
    expect(card('海外模型服务')).toHaveAttribute('aria-current', 'true')
    expect(keyCount('海外模型服务')).toEqual(['2', '0'])
    expect(within(panel()).getByText('暂无密钥，请点击「添加密钥」接入')).toBeVisible()
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /api/model-providers',
      expect.stringMatching(/\/credentials\/test$/),
    ])
  })
})

describe('密钥', () => {
  it('试连没通过时写出原因，不拦保存；保存时不试连', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    await user.click(within(panel()).getByRole('button', { name: '添加密钥' }))
    const form = formNamed('添加密钥')
    await user.type(form.getByLabelText('名称'), '备用账号')
    await user.type(form.getByLabelText('API Key'), 'sk-invalid-0000')
    await user.click(form.getByRole('button', { name: '试连' }))

    expect(await form.findByText('接口返回 401，API Key 无效')).toBeVisible()
    await user.type(form.getByLabelText('API Key'), '1')
    expect(form.queryByText('接口返回 401，API Key 无效')).toBeNull()
    await user.click(form.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(within(panel()).queryByRole('form')).toBeNull())
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      expect.stringMatching(/^POST .*\/credentials\/test$/),
      expect.stringMatching(/^POST .*\/credentials$/),
    ])
    expect(rowOf(within(panel()).getByText('备用账号')).getByText('••••0001')).toBeVisible()
  })

  it('修改时机密字段留空就是不改：只改名不带字段；改了接口地址只提交这一项，不用先试连', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()

    await user.click(within(panel()).getByRole('button', { name: '编辑密钥 创作团队' }))
    let form = formNamed('编辑密钥')
    expect(form.getByLabelText('API Key')).toHaveValue('')
    await user.clear(form.getByLabelText('名称'))
    await user.type(form.getByLabelText('名称'), '创作二组')
    await user.click(form.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(panel()).queryByRole('form')).toBeNull())
    expect(sent).toEqual([
      {
        body: { name: '创作二组' },
        method: 'PATCH',
        path: expect.stringMatching(/\/credentials\/[\w-]+$/),
      },
    ])

    await user.click(within(panel()).getByRole('button', { name: '编辑密钥 创作二组' }))
    form = formNamed('编辑密钥')
    const url = form.getByLabelText('接口地址')
    await user.clear(url)
    await user.type(url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
    await user.click(form.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(panel()).queryByRole('form')).toBeNull())

    const fields = { base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }
    expect(sent.slice(1).map(({ body, method }) => ({ body, method }))).toEqual([
      { body: { fields }, method: 'PATCH' },
    ])
    const row = rowOf(within(panel()).getByText('创作二组'))
    expect(row.getByText('••••7F2A')).toBeVisible()
  })

  it('把另一把设为默认密钥；默认密钥不能删除，原因在提示里', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    const main = within(panel()).getByRole('button', { name: '删除密钥 主账号' })
    expect(main).toHaveAttribute('aria-disabled', 'true')
    await user.click(main)
    expect(sent).toEqual([])

    await user.click(within(panel()).getByRole('button', { name: '把 创作团队 设为默认密钥' }))
    await waitFor(() =>
      expect(rowOf(within(panel()).getByText('创作团队')).getByText('默认')).toBeVisible(),
    )
    expect(sent).toEqual([
      {
        body: { defaultCredentialId: expect.any(String) },
        method: 'PATCH',
        path: expect.stringMatching(/^\/api\/model-providers\/[\w-]+$/),
      },
    ])
    expect(rowOf(within(panel()).getByText('主账号')).queryByText('默认')).toBeNull()
    expect(within(panel()).getByRole('button', { name: '删除密钥 主账号' })).not.toHaveAttribute(
      'aria-disabled',
    )
  })
})

describe('模型', () => {
  it('百炼的添加模型表单可选 responses 与 chat，默认 responses', async () => {
    const user = await renderPage()
    await openProviders(user)
    await user.click(within(panel()).getByRole('button', { name: '添加模型' }))
    const apis = formNamed('添加模型').getByRole('radiogroup', { name: '模型接口' })

    expect(
      within(apis)
        .getAllByRole('radio')
        .map((node) => node.textContent),
    ).toEqual(['responses', 'chat'])
    expect(within(apis).getByRole('radio', { name: 'responses' })).toBeChecked()
  })

  it('Gemini 只有一种接口：不给选，添加的模型走 gemini；没模型时试连提示先加模型', async () => {
    const user = await renderPage()
    await openProviders(user)
    const keyForm = await createProviderFor(user, 'Google Gemini', '谷歌', 'google-main')
    expect(keyForm.getByLabelText('接口地址')).toHaveValue('')
    await user.type(keyForm.getByLabelText('名称'), '主账号')
    await user.type(keyForm.getByLabelText('API Key'), 'AIza-mock-0001')
    await user.click(keyForm.getByRole('button', { name: '试连' }))
    const status = keyForm.getByRole('status')
    expect(await within(status).findByText('先添加一个模型再试连')).toBeVisible()
    expect(within(status).getByRole('img', { name: '试连没通过' })).toBeVisible()
    expect(keyForm.queryByRole('alert')).toBeNull()
    await user.click(keyForm.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(panel()).queryByRole('form')).toBeNull())

    const sent = recordWrites()
    await user.click(within(panel()).getByRole('button', { name: '添加模型' }))
    const form = formNamed('添加模型')
    expect(form.queryByRole('radiogroup', { name: '模型接口' })).toBeNull()
    await user.type(form.getByLabelText('模型名'), 'gemini-3.8-flash')
    await user.click(form.getByRole('button', { name: '保存' }))

    expect(
      await within(panel()).findByRole('switch', { name: '启用模型 gemini-3.8-flash' }),
    ).toBeChecked()
    expect(sent).toEqual([
      {
        body: {
          api: 'gemini',
          contextSize: null,
          name: 'gemini-3.8-flash',
          thinking: [],
          type: 'llm',
        },
        method: 'POST',
        path: expect.stringMatching(/\/models$/),
      },
    ])
  })

  it('OpenAI 兼容：密钥要填接口地址；添加模型可选 chat 与 responses，默认 chat', async () => {
    const user = await renderPage()
    await openProviders(user)
    const keyForm = await createProviderFor(user, 'OpenAI 兼容', '自建网关', 'gateway')
    await user.type(keyForm.getByLabelText('名称'), '主账号')
    await user.type(keyForm.getByLabelText('API Key'), 'sk-gateway-0001')
    await user.click(keyForm.getByRole('button', { name: '保存' }))
    expect(await keyForm.findByText('请填写接口地址')).toBeVisible()
    await user.click(keyForm.getByRole('button', { name: '取消' }))

    await user.click(within(panel()).getByRole('button', { name: '添加模型' }))
    const apis = formNamed('添加模型').getByRole('radiogroup', { name: '模型接口' })
    expect(
      within(apis)
        .getAllByRole('radio')
        .map((node) => node.textContent),
    ).toEqual(['chat', 'responses'])
    expect(within(apis).getByRole('radio', { name: 'chat' })).toBeChecked()
  })

  it('测试一个模型：用默认密钥请求，结果写在那一行下面；没有密钥时写明原因', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()

    await user.click(within(panel()).getByRole('button', { name: '测试模型 qwen3.8-flash' }))

    const row = rowOf(within(panel()).getByRole('switch', { name: '启用模型 qwen3.8-flash' }))
    expect(await row.findByText('236 ms')).toBeVisible()
    expect(row.getByRole('img', { name: '测试通过' })).toBeVisible()
    expect(sent).toEqual([
      {
        body: { name: 'qwen3.8-flash', type: 'llm' },
        method: 'POST',
        path: expect.stringMatching(/^\/api\/model-providers\/[\w-]+\/models\/test$/),
      },
    ])
    expect(within(panel()).queryByRole('button', { name: '测试模型 text-embedding-v4' })).toBeNull()

    await createProviderFor(user, null, '新服务', 'fresh')
    await user.click(within(panel()).getByRole('button', { name: '取消' }))
    await user.click(within(panel()).getByRole('button', { name: '测试模型 ZHIPU/GLM-5.3-Flash' }))
    const fresh = rowOf(
      within(panel()).getByRole('switch', { name: '启用模型 ZHIPU/GLM-5.3-Flash' }),
    )
    expect(await fresh.findByText('没法测试：先添加密钥')).toBeVisible()
    expect(fresh.getByRole('img', { name: '测试没通过' })).toBeVisible()
  })

  it('添加自己的模型，agent 的「模型设置」随之能选到它', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    await user.click(within(panel()).getByRole('button', { name: '添加模型' }))
    const form = formNamed('添加模型')
    await user.type(form.getByLabelText('模型名'), 'qwen3.8-turbo')
    await user.type(form.getByLabelText('上下文长度'), '128K')
    await user.click(form.getByRole('button', { name: '中' }))
    await user.click(form.getByRole('button', { name: '保存' }))

    expect(
      await within(panel()).findByRole('switch', { name: '启用模型 qwen3.8-turbo' }),
    ).toBeChecked()
    expect(sent).toEqual([
      {
        body: {
          api: 'responses',
          contextSize: 131_072,
          name: 'qwen3.8-turbo',
          thinking: ['medium'],
          type: 'llm',
        },
        method: 'POST',
        path: expect.stringMatching(/\/models$/),
      },
    ])

    await user.click(screen.getByRole('tab', { name: 'Agent' }))
    await user.click(screen.getByRole('button', { name: /^模型设置：/ }))
    const models = screen.getByRole('region', { name: '模型设置' })
    expect(await within(models).findByRole('radio', { name: /qwen3.8-turbo/ })).toBeVisible()
  })

  it('停用名字带斜杠的模型；在用的模型开关被拦下，后端拦下的 409 写在那一行', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()

    const glm = within(panel()).getByRole('switch', { name: '启用模型 ZHIPU/GLM-5.3-Flash' })
    await user.click(glm)
    await waitFor(() => expect(glm).not.toBeChecked())
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      expect.stringMatching(
        /^PATCH \/api\/model-providers\/[\w-]+\/models\/llm\/ZHIPU\/GLM-5.3-Flash$/,
      ),
    ])

    const plus = within(panel()).getByRole('switch', { name: '启用模型 qwen3.8-plus' })
    expect(plus).toHaveAttribute('aria-disabled', 'true')
    await user.click(plus)
    expect(sent).toHaveLength(1)

    server.use(
      http.patch('*/api/model-providers/:providerId/models/*', () =>
        HttpResponse.json({ detail: '分镜助手正在使用，不能停用' }, { status: 409 }),
      ),
    )
    const max = within(panel()).getByRole('switch', { name: '启用模型 qwen3.8-max' })
    await user.click(max)
    expect(await rowOf(max).findByRole('alert')).toHaveTextContent('分镜助手正在使用，不能停用')
    expect(max).toBeChecked()
  })
})

describe('删除供应商', () => {
  it('有 agent 在用时删除被拦下；没人用的可以删', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    const blocked = within(panel()).getByRole('button', { name: '删除供应商' })
    expect(blocked).toHaveAttribute('aria-disabled', 'true')
    await user.click(blocked)
    expect(sent).toEqual([])

    await user.click(card('团队模型服务'))
    await waitFor(() =>
      expect(within(panel()).getByRole('textbox', { name: '供应商显示名' })).toHaveValue(
        '团队模型服务',
      ),
    )
    await user.click(within(panel()).getByRole('button', { name: '删除供应商' }))
    await waitFor(() =>
      expect(within(panel()).queryByRole('button', { name: '供应商：团队模型服务' })).toBeNull(),
    )
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      expect.stringMatching(/^DELETE \/api\/model-providers\/[\w-]+$/),
    ])
    expect(card('阿里云百炼')).toHaveAttribute('aria-current', 'true')
  })
})

describe('默认模型', () => {
  it('从启用的模型里换 llm 的默认模型', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    await user.click(
      within(panel()).getByRole('button', { name: /^llm 默认模型：阿里云百炼 qwen3.8-flash$/ }),
    )
    await user.click(await screen.findByRole('menuitemradio', { name: /^studio-chat-long/ }))

    expect(
      await within(panel()).findByRole('button', {
        name: 'llm 默认模型：团队模型服务 studio-chat-long',
      }),
    ).toBeVisible()
    expect(sent).toEqual([
      {
        body: { modelName: 'studio-chat-long', providerId: expect.any(String) },
        method: 'PUT',
        path: '/api/default-models/llm',
      },
    ])
    expect(within(panel()).getByRole('button', { name: 'rerank 默认模型：未设置' })).toBeVisible()
  })
})
