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

/** 记下发往模型供应商与默认模型端点的写请求，响应仍交给预置的 mock。 */
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
  /** 只建供应商：接入方式、显示名、引用名；建好后选中它并展开「添加密钥」。 */
  const createProvider = async (user: User) => {
    await user.click(within(panel()).getByRole('button', { name: '添加供应商' }))
    const form = formNamed('添加供应商')
    expect(form.queryByLabelText('API Key')).toBeNull()
    await user.type(form.getByLabelText('显示名'), '海外模型服务')
    await user.type(form.getByLabelText('引用名'), 'overseas')
    await user.click(form.getByRole('button', { name: '添加' }))
    return within(await within(panel()).findByRole('form', { name: '添加密钥' }))
  }

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
    // 卡片上是模型数与密钥数：声明里的 2 个模型，还没有密钥。
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

  it('新供应商的密钥试连没通过时不能保存；取消后供应商照样留在列表里，没有密钥', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    const keyForm = await createProvider(user)
    await user.type(keyForm.getByLabelText('名称'), '海外账号')
    await user.type(keyForm.getByLabelText('API Key'), 'sk-invalid-9999')
    await user.click(keyForm.getByRole('button', { name: '试连' }))
    expect(await keyForm.findByText('接口返回 401，API Key 无效')).toBeVisible()
    expect(keyForm.getByRole('button', { name: '保存' })).toBeDisabled()

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
  it('试连没通过时写出原因，不能保存', async () => {
    const user = await renderPage()
    await openProviders(user)
    const sent = recordWrites()
    await user.click(within(panel()).getByRole('button', { name: '添加密钥' }))
    const form = formNamed('添加密钥')
    await user.type(form.getByLabelText('名称'), '备用账号')
    await user.type(form.getByLabelText('API Key'), 'sk-invalid-0000')
    await user.click(form.getByRole('button', { name: '试连' }))

    expect(await form.findByText('接口返回 401，API Key 无效')).toBeVisible()
    const save = form.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    await user.click(save)
    expect(sent.map(({ path }) => path)).toEqual([expect.stringMatching(/\/credentials\/test$/)])
    // 改了字段，上一次的结果作废。
    await user.type(form.getByLabelText('API Key'), '1')
    expect(form.queryByText('接口返回 401，API Key 无效')).toBeNull()
  })

  it('修改时机密字段留空就是不改：只改名不试连、不带字段；改了接口地址要先试连，只提交这一项', async () => {
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
    expect(form.getByRole('button', { name: '保存' })).toBeDisabled()
    await user.click(form.getByRole('button', { name: '试连' }))
    expect(await form.findByText('236 ms')).toBeVisible()
    await user.click(form.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(panel()).queryByRole('form')).toBeNull())

    const fields = { base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }
    expect(sent.slice(1).map(({ body, method }) => ({ body, method }))).toEqual([
      { body: { credentialId: expect.any(String), fields }, method: 'POST' },
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

    // 读到列表后别人把它挂到了 agent 上：页面以为没人用，后端答 409。
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
