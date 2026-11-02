import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AgentConfigPage } from '@/features/agent-config'
import { pasteTextIntoComposer } from '@/testing/editor'
import { loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { FakeTranscriptServer } from '@/testing/transcript-server'
import { Toaster } from '@/shared/ui/toast'
import { AgentPreviewConversation } from './-agent-preview-conversation'

// jsdom 不支持 Lottie 加载时的 canvas 探测；替换进行中状态的装饰动画。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

type PromptBody = { prompt_id: string; content: { type: string; text?: string }[] }

const at = (ms: number) => new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + ms).toISOString()

const REPLY = '可以，先拍网面细节。'

/**
 * 假后端：开预览交回新 id 并建一条空流；发消息记下来，按 `reply` 决定怎么答：
 * 默认受理并跑完一轮（读参考素材 1.2 秒、回复 3.8 秒），也可以只受理不收尾，或回 409 `agent_unavailable`。
 */
const setup = () => {
  const fake = new FakeTranscriptServer()
  const opened: { agentId: string; body: unknown; id: string }[] = []
  const prompts: { conversationId: string; body: PromptBody }[] = []
  const aborts: string[] = []
  const state: { reply: 'finish' | 'hold' | 'unavailable' } = { reply: 'finish' }

  const runTurn = (conversationId: string, body: PromptBody, finish: boolean) => {
    const turn = {
      content: body.content,
      kind: 'turn',
      ordinal: 1,
      origin: { kind: 'user' },
      startedAt: at(0),
      state: 'running',
      triggerPromptId: body.prompt_id,
      turnId: 't1',
    }
    fake.push(conversationId, 'main', [
      {
        op: 'prompt.upsert',
        prompt: { createdAt: at(0), promptId: body.prompt_id, status: 'running' },
      },
      { op: 'turn.upsert', turn },
      { meta: { activity: 'turn' }, op: 'meta.merge' },
    ] as never)
    if (!finish) return
    const step = (ordinal: number, startedAt: number, endedAt: number) => ({
      op: 'step.upsert',
      step: {
        endedAt: at(endedAt),
        kind: 'step',
        ordinal,
        startedAt: at(startedAt),
        state: 'completed',
        stepId: `t1.${ordinal}`,
        turnId: 't1',
      },
      turnId: 't1',
    })
    fake.push(conversationId, 'main', [
      step(1, 0, 1200),
      {
        frame: {
          display: { detail: '跑道试穿.mp4', kind: 'generic', summary: '读取参考素材' },
          frameId: 't1.1.call',
          kind: 'tool',
          name: 'read_reference',
          output: '已读取',
          state: 'done',
          toolCallId: 'call_read',
        },
        op: 'frame.upsert',
        stepId: 't1.1',
        turnId: 't1',
      },
      step(2, 1200, 5000),
      {
        frame: { frameId: 't1.2.f1', kind: 'text', role: 'assistant', text: REPLY },
        op: 'frame.upsert',
        stepId: 't1.2',
        turnId: 't1',
      },
      { op: 'turn.upsert', turn: { ...turn, endedAt: at(5000), state: 'completed' } },
      {
        op: 'prompt.upsert',
        prompt: {
          createdAt: at(0),
          finishedAt: at(5000),
          promptId: body.prompt_id,
          status: 'completed',
        },
      },
      { meta: { activity: 'idle' }, op: 'meta.merge' },
    ] as never)
  }

  server.use(
    ...fake.handlers(),
    http.post('*/api/agents/:agentId/previews', async ({ params, request }) => {
      const raw = await request.text()
      const id = `0199bbbb-0000-7000-8000-00000000000${opened.length + 1}`
      const agentId = String(params['agentId'])
      const body: unknown = raw === '' ? null : JSON.parse(raw)
      opened.push({ agentId, body, id })
      fake.seed(id, 'main', { items: [], title: '测试预览' })
      const versionId = (body as { versionId?: string } | null)?.versionId ?? null
      return HttpResponse.json({ agentId, createdAt: at(0), id, versionId }, { status: 201 })
    }),
    http.post('*/api/conversations/:conversationId/prompts', async ({ params, request }) => {
      const conversationId = String(params['conversationId'])
      const body = (await request.json()) as PromptBody
      prompts.push({ body, conversationId })
      if (state.reply === 'unavailable')
        return HttpResponse.json(
          { code: 'agent_unavailable', detail: '草稿还没有选模型，无法试用' },
          { status: 409 },
        )
      runTurn(conversationId, body, state.reply === 'finish')
      return HttpResponse.json({ createdAt: at(0), promptId: body.prompt_id, status: 'running' })
    }),
    http.post('*/api/conversations/:conversationId/prompts/*', ({ request }) => {
      aborts.push(new URL(request.url).pathname)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return { aborts, fake, opened, prompts, state }
}

function Harness() {
  const [agentId, setAgentId] = useState<string | undefined>('director')
  return (
    <>
      <AgentConfigPage
        agentId={agentId}
        onAgentChange={setAgentId}
        PreviewConversation={AgentPreviewConversation}
      />
      <Toaster />
    </>
  )
}

const renderPage = async (fake: FakeTranscriptServer) => {
  loginAs(mockGovernor)
  const user = userEvent.setup()
  await renderWithProviders(<Harness />, { createSocket: fake.createSocket })
  await screen.findByRole('button', { name: /^切换 Agent，当前：/ })
  return user
}

const preview = () => screen.getByRole('region', { name: 'Agent 预览' })
const editor = () => screen.getByRole('region', { name: 'Agent 配置编辑器' })
/** 看得见的那段试聊的输入框；看不见的几段对读屏隐藏，按角色找不到。 */
const input = () => within(preview()).getByRole('textbox', { name: '输入消息' })
/** 看得见的那段试聊里有没有这句话（文字查询不管读屏隐藏，这里自己筛掉）。 */
const shown = (text: string) =>
  within(preview())
    .queryAllByText(text)
    .filter((node) => node.closest('[aria-hidden="true"]') === null)
/** 输入框为空时的提示（叠在编辑区上、对读屏隐藏的那一层字）。 */
const placeholder = () => input().parentElement?.parentElement?.textContent
const resetButton = () => within(preview()).getByRole('button', { name: '新建测试对话' })

const send = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  pasteTextIntoComposer(input(), text)
  await user.click(within(preview()).getByRole('button', { name: '发送' }))
}

const switchAgent = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(within(editor()).getByRole('button', { name: /^切换 Agent，当前：/ }))
  await user.click(await screen.findByRole('menuitemradio', { name }))
}

describe('Agent 配置页的测试预览', () => {
  it('第一条消息发出时才开预览：试草稿不带版本，消息发到预览 id，回复出现在预览里', async () => {
    const backend = setup()
    const user = await renderPage(backend.fake)
    expect(placeholder()).toBe('输入需求，或添加参考素材…')
    expect(backend.opened).toHaveLength(0)

    await send(user, '为网面跑鞋做一条 15 秒竖版短片')

    await waitFor(() => expect(shown(REPLY)).toHaveLength(1))
    expect(backend.opened).toEqual([{ agentId: 'director', body: {}, id: backend.opened[0]?.id }])
    expect(backend.prompts).toHaveLength(1)
    expect(backend.prompts[0]?.conversationId).toBe(backend.opened[0]?.id)
    expect(backend.prompts[0]?.body.content).toEqual([
      { text: '为网面跑鞋做一条 15 秒竖版短片', type: 'text' },
    ])

    // 再发一条用同一段预览，不再开新的。
    backend.state.reply = 'hold'
    await send(user, '再短一点')
    await waitFor(() => expect(backend.prompts).toHaveLength(2))
    expect(backend.prompts[1]?.conversationId).toBe(backend.opened[0]?.id)
    expect(backend.opened).toHaveLength(1)
  })

  it('看历史版本时试的是那一版：占位写版本号，开预览带版本 id；换了要试的就是一段没开的新试聊', async () => {
    const backend = setup()
    const user = await renderPage(backend.fake)
    const versions = (await (
      await fetch('http://localhost/api/agents/director/versions')
    ).json()) as { items: { id: string; version: number }[] }
    const v5 = versions.items.find((item) => item.version === 5)
    const pickVersion = async (name: RegExp) => {
      await user.click(within(editor()).getByRole('button', { name: /^查看版本，当前：/ }))
      await user.click(await screen.findByRole('menuitemradio', { name }))
    }
    await send(user, '草稿这边试一条')
    await waitFor(() => expect(shown(REPLY)).toHaveLength(1))

    await pickVersion(/^v5，/)
    await waitFor(() => expect(placeholder()).toBe('用 v5 测试…'))
    expect(shown('草稿这边试一条')).toHaveLength(0)
    expect(shown(REPLY)).toHaveLength(0)
    expect(resetButton()).toHaveAttribute('aria-disabled', 'true')
    await send(user, '试一下 v5')
    await waitFor(() => expect(shown(REPLY)).toHaveLength(1))
    expect(backend.opened.map((item) => item.body)).toEqual([{}, { versionId: v5?.id }])

    // 一版换到另一版：同样是新的一段。
    await pickVersion(/^v4，/)
    await waitFor(() => expect(placeholder()).toBe('用 v4 测试…'))
    expect(shown('试一下 v5')).toHaveLength(0)
    expect(shown(REPLY)).toHaveLength(0)

    // 回到草稿不再是原来那段草稿试聊；再看 v5 也不是原来那段。
    await user.click(within(editor()).getByRole('button', { name: '返回草稿' }))
    await waitFor(() => expect(placeholder()).toBe('输入需求，或添加参考素材…'))
    expect(shown('草稿这边试一条')).toHaveLength(0)
    expect(shown(REPLY)).toHaveLength(0)
    await pickVersion(/^v5，/)
    await waitFor(() => expect(placeholder()).toBe('用 v5 测试…'))
    expect(shown('试一下 v5')).toHaveLength(0)
    expect(shown(REPLY)).toHaveLength(0)
    expect(backend.opened).toHaveLength(2)

    backend.state.reply = 'hold'
    await send(user, '再试 v5')
    await waitFor(() => expect(backend.prompts).toHaveLength(3))
    expect(backend.opened.map((item) => item.body)).toEqual([
      {},
      { versionId: v5?.id },
      { versionId: v5?.id },
    ])
    expect(backend.prompts[2]?.conversationId).toBe(backend.opened[2]?.id)
  })

  it('每个 agent 各有一段预览：切走再切回来还是原来那段，不重开', async () => {
    const backend = setup()
    const user = await renderPage(backend.fake)
    await send(user, '导演这边试一条')
    await waitFor(() => expect(shown(REPLY)).toHaveLength(1))

    await switchAgent(user, /^分镜助手/)
    await screen.findByRole('button', { name: '切换 Agent，当前：分镜助手' })
    expect(shown('导演这边试一条')).toHaveLength(0)
    backend.state.reply = 'hold'
    await send(user, '分镜这边试一条')
    await waitFor(() => expect(shown('分镜这边试一条')).toHaveLength(1))

    await switchAgent(user, /^AI 导演/)
    await screen.findByRole('button', { name: '切换 Agent，当前：AI 导演' })
    expect(shown('导演这边试一条')).toHaveLength(1)
    expect(shown(REPLY)).toHaveLength(1)
    expect(shown('分镜这边试一条')).toHaveLength(0)
    expect(backend.opened.map((item) => item.agentId)).toEqual(['director', 'storyboard-helper'])
    expect(backend.prompts.map((item) => item.conversationId)).toEqual(
      backend.opened.map((item) => item.id),
    )
  })

  it('新建测试对话只换成一段没开的试聊、不发请求，下一条消息才开新的预览', async () => {
    const backend = setup()
    const user = await renderPage(backend.fake)
    expect(resetButton()).toHaveAttribute('aria-disabled', 'true')
    await send(user, '第一段')
    await waitFor(() => expect(shown(REPLY)).toHaveLength(1))
    const requests: string[] = []
    const record = ({ request }: { request: Request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    }
    server.events.on('request:start', record)

    await user.click(resetButton())

    await waitFor(() => expect(shown(REPLY)).toHaveLength(0))
    expect(shown('第一段')).toHaveLength(0)
    expect(resetButton()).toHaveAttribute('aria-disabled', 'true')
    expect(requests.filter((line) => line.includes('/previews'))).toEqual([])
    expect(backend.opened).toHaveLength(1)

    backend.state.reply = 'hold'
    await send(user, '第二段')
    await waitFor(() => expect(backend.prompts).toHaveLength(2))
    server.events.removeListener('request:start', record)
    expect(requests.filter((line) => line.includes('/previews'))).toEqual([
      'POST /api/agents/director/previews',
    ])
    expect(backend.opened).toHaveLength(2)
    expect(backend.opened[1]?.id).not.toBe(backend.opened[0]?.id)
    expect(backend.prompts[1]?.conversationId).toBe(backend.opened[1]?.id)
  })

  it('草稿此刻装配不起来：原因写在输入框上方，输入内容留着，再发用的还是这一段', async () => {
    const backend = setup()
    backend.state.reply = 'unavailable'
    const user = await renderPage(backend.fake)

    await send(user, '试一下')

    expect(await within(preview()).findByRole('alert')).toHaveTextContent(
      '草稿还没有选模型，无法试用',
    )
    expect(input()).toHaveTextContent('试一下')
    backend.state.reply = 'finish'
    await user.click(within(preview()).getByRole('button', { name: '发送' }))
    await waitFor(() => expect(shown(REPLY)).toHaveLength(1))
    expect(within(preview()).queryByRole('alert')).not.toBeInTheDocument()
    expect(backend.opened).toHaveLength(1)
    expect(backend.prompts.map((item) => item.conversationId)).toEqual([
      backend.opened[0]?.id,
      backend.opened[0]?.id,
    ])
  })

  it('在跑时能停：停止发到预览 id 上的那条消息', async () => {
    const backend = setup()
    backend.state.reply = 'hold'
    const user = await renderPage(backend.fake)
    await send(user, '慢慢跑')

    await user.click(await within(preview()).findByRole('button', { name: '停止' }))

    await waitFor(() =>
      expect(backend.aborts).toEqual([
        `/api/conversations/${backend.opened[0]?.id}/prompts/${backend.prompts[0]?.body.prompt_id}:abort`,
      ]),
    )
  })

  it('运行过程按步骤列出这一轮：名称与耗时，点开看这一步做了什么', async () => {
    const backend = setup()
    const user = await renderPage(backend.fake)
    await user.click(within(preview()).getByRole('tab', { name: '运行过程' }))
    expect(shown('暂无运行记录，请先在「测试预览」发送一条消息')).toHaveLength(1)

    await send(user, '为网面跑鞋做一条短片')

    const trace = await within(preview()).findByRole('region', { name: '运行过程' })
    const turn = await within(trace).findByRole('region', { name: '为网面跑鞋做一条短片' })
    await waitFor(() => expect(within(turn).getAllByRole('listitem')).toHaveLength(2))
    const [read, reply] = within(turn).getAllByRole('listitem') as [HTMLElement, HTMLElement]
    expect(within(read).getByText('读取参考素材')).toBeVisible()
    expect(within(read).getByText('1.2 s')).toBeVisible()
    expect(within(reply).getByText('回复')).toBeVisible()
    expect(within(reply).getByText('3.8 s')).toBeVisible()
    expect(within(turn).getByText('5.0 s')).toBeVisible()

    const step = within(read).getByRole('button', { name: /读取参考素材/ })
    expect(step).toHaveAttribute('aria-expanded', 'false')
    await user.click(step)
    expect(step).toHaveAttribute('aria-expanded', 'true')
    expect(within(read).getByText('跑道试穿.mp4')).toBeVisible()
    // 只回复的步骤没有可展开的内容。
    expect(within(reply).queryByRole('button')).not.toBeInTheDocument()

    // 切回测试预览，对话还在。
    await user.click(within(preview()).getByRole('tab', { name: '测试预览' }))
    expect(shown(REPLY)).toHaveLength(1)
  })
})
