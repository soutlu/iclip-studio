import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { addMockCollection, addMockConversation } from '@/testing/mocks/conversations'
import { addMockUser, loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { MOCK_STREAM_EPOCH, mockTranscriptPage } from '@/testing/mocks/transcript'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { ShellChromeContext } from '@/shared/shell'
import { Toaster } from '@/shared/ui/toast'
import { conversationsQueryKeys, type SidebarTopology } from '../conversations.api'
import { ConversationRoute } from './conversation-route'
import { sessionEnvelope } from '@/testing/ws'

// jsdom 不支持 Lottie 加载时的 canvas 探测；替换装饰动画以验证会话行为。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

const TAIL_TEXT = '这是第 2 轮的回复。'

/** renderWithProviders 完成连接握手，返回 socket 供测试发送后续帧。 */
const renderConversation = async () =>
  renderWithProviders(<ConversationRoute conversationId="c1" />)

/** 路由按对话 id 换键重挂；这里用开关模拟离开再回来同一段对话。 */
function RemountableConversation() {
  const [shown, setShown] = useState(true)
  return (
    <>
      <button onClick={() => setShown(false)} type="button">
        离开
      </button>
      <button onClick={() => setShown(true)} type="button">
        回来
      </button>
      {shown ? <ConversationRoute conversationId="c1" /> : null}
    </>
  )
}

const opsFrame = (ops: unknown[], seq: number) => ({
  payload: { agent_id: 'main', ops, seq },
  session_id: 'c1',
  stream_epoch: MOCK_STREAM_EPOCH,
  type: 'transcript.ops',
})

const runningPrompt = (promptId: string) => ({
  op: 'prompt.upsert',
  prompt: { createdAt: '2026-08-31T03:00:00Z', promptId, status: 'running' },
})

/** 审批卡通过 approvalId 匹配工具调用。 */
const APPROVAL_TURN = {
  kind: 'turn',
  ordinal: 3,
  origin: { kind: 'user' },
  content: [{ text: '把两张镜头帧拼成封面', type: 'text' }],
  startedAt: '2026-08-31T02:10:00Z',
  state: 'running',
  steps: [
    {
      frames: [
        {
          approvalId: 'appr_1',
          display: {
            content: '# 封面\n\n两张镜头帧拼版，主图在左。',
            kind: 'file_io',
            operation: 'write',
            path: 'shots/cover.md',
          },
          frameId: 'ta.1.f1',
          input: { path: 'shots/cover.md' },
          kind: 'tool',
          name: 'write_file',
          state: 'running',
          toolCallId: 'call_cover',
        },
      ],
      kind: 'step',
      ordinal: 1,
      startedAt: '2026-08-31T02:10:00Z',
      state: 'running',
      stepId: 'ta.1',
      turnId: 'ta',
    },
  ],
  turnId: 'ta',
}

/** 渲染前替换基线为等待审批状态；ownerUserId 可换成别人、deletedAt 可给时刻，用来演治理者复盘。 */
const serveApprovalPage = (ownerUserId = mockAuthUser.id, deletedAt: string | null = null) => {
  const page = mockTranscriptPage()
  server.use(
    http.get('*/api/conversations/c1/transcript', () =>
      HttpResponse.json({
        ...page,
        deleted_at: deletedAt,
        owner_user_id: ownerUserId,
        interactions: [
          {
            interactionId: 'appr_1',
            interactionKind: 'approval',
            state: 'pending',
            toolCallId: 'call_cover',
          },
        ],
        items: [...page.items, APPROVAL_TURN],
        meta: { ...page.meta, activity: 'turn' },
        pending_interactions: ['appr_1'],
        prompts: [{ createdAt: '2026-08-31T02:10:00Z', promptId: 'p-cover', status: 'running' }],
      }),
    ),
  )
}

const queuedPrompt = (promptId: string, text: string) => ({
  op: 'prompt.upsert',
  prompt: {
    content: [{ text, type: 'text' }],
    createdAt: '2026-08-31T03:00:01Z',
    promptId,
    status: 'queued',
  },
})

describe('ConversationRoute', () => {
  it('栏头将换位与折叠操作交给壳层', async () => {
    const onCollapse = vi.fn()
    const onSwapPanes = vi.fn()
    await renderWithProviders(
      <ShellChromeContext value={{ chat: { onCollapse }, onSwapPanes, sidebarOverlay: false }}>
        <ConversationRoute conversationId="c1" />
      </ShellChromeContext>,
    )

    await userEvent.click(screen.getByRole('button', { name: '交换对话与工作台' }))
    await userEvent.click(screen.getByRole('button', { name: '折叠对话' }))

    expect(onSwapPanes).toHaveBeenCalledTimes(1)
    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('第 1 个问题')).toBeInTheDocument()
  })

  it('在输入框底部显示后端给出的上下文占用环', async () => {
    await renderConversation()

    expect(
      await screen.findByRole('button', { name: '3.1% · 32.8k / 1M 上下文已使用' }),
    ).toBeInTheDocument()
  })

  it('把历史那几轮铺开：用户那条、模型那条、工具卡', async () => {
    await renderConversation()

    expect(await screen.findByText('第 1 个问题')).toBeInTheDocument()
    expect(screen.getByText(TAIL_TEXT)).toBeInTheDocument()
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    expect(screen.getByText('shots/storyboard.md')).toBeInTheDocument()
    expect(screen.queryByText('read_file')).not.toBeInTheDocument()
  })

  it('还有更早的轮次时顶部给「加载更早」：按最早一轮往前取一页，接在前面；失败了改口让人重试', async () => {
    const user = userEvent.setup()
    const longId = '0199aaaa-0000-7000-8000-0000000000aa'
    const asked: (string | null)[] = []
    let failOnce = true
    server.use(
      http.get(`*/api/conversations/${longId}/transcript`, ({ request }) => {
        const query = new URL(request.url).searchParams
        const beforeTurn = query.get('before_turn')
        asked.push(beforeTurn)
        if (beforeTurn !== null && failOnce) {
          failOnce = false
          return HttpResponse.json({ detail: '服务暂时不可用' }, { status: 503 })
        }
        return HttpResponse.json(
          mockTranscriptPage(longId, { beforeTurn, pageSize: Number(query.get('page_size')) }),
        )
      }),
    )
    await renderWithProviders(<ConversationRoute conversationId={longId} />)

    expect(await screen.findByText('长对话第 14 轮的回复。')).toBeInTheDocument()
    expect(screen.getByText('长对话第 5 轮的回复。')).toBeInTheDocument()
    expect(screen.queryByText('长对话第 4 轮的回复。')).not.toBeInTheDocument()
    expect(asked).toEqual([null])

    await user.click(screen.getByRole('button', { name: '加载更早的消息' }))
    await user.click(await screen.findByRole('button', { name: '加载失败，点这里重试' }))

    expect(await screen.findByText('长对话第 1 轮的回复。')).toBeInTheDocument()
    expect(asked).toEqual([null, 't5', 't5'])
    const replies = screen.getAllByText(/^长对话第 \d+ 轮的回复。$/).map((node) => node.textContent)
    expect(replies).toHaveLength(14)
    expect(replies[0]).toBe('长对话第 1 轮的回复。')
    expect(screen.queryByRole('button', { name: '加载更早的消息' })).not.toBeInTheDocument()
  })

  it('逐字追加接在同一块上，不另起一段', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver({
      payload: {
        agent_id: 'main',
        ops: [
          {
            offset: TAIL_TEXT.length,
            op: 'append',
            target: { frameId: 't2.1.f3', stepId: 't2.1', turnId: 't2', type: 'frame' },
            text: '再补一句。',
          },
        ],
        seq: 11,
      },
      session_id: 'c1',
      stream_epoch: MOCK_STREAM_EPOCH,
      type: 'transcript.ops',
    })

    expect(await screen.findByText(`${TAIL_TEXT}再补一句。`)).toBeInTheDocument()
  })

  it('发出去先挂气泡，服务端记下它之后交给时间线', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let submitted = ''
    let submittedContent: unknown
    server.use(
      http.post('*/api/conversations/c1/prompts', async ({ request }) => {
        const body = (await request.json()) as { content: { text: string }[]; prompt_id: string }
        submitted = body.prompt_id
        submittedContent = body.content
        return HttpResponse.json({
          createdAt: '2026-08-31T03:00:00Z',
          promptId: body.prompt_id,
          status: 'running',
        })
      }),
    )

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => {
      expect(screen.getAllByText('再拆一段')).toHaveLength(1)
    })
    expect(screen.getByRole('status')).toHaveTextContent('请求中…')
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('')
    expect(submitted).not.toBe('')
    expect(submittedContent).toEqual([{ text: '再拆一段', type: 'text' }])

    // running prompt 不撤销乐观气泡，须由匹配的 turn.prompt 接替。
    socket.deliver(opsFrame([runningPrompt(submitted)], 11))

    expect(await screen.findByRole('status')).toHaveTextContent('请求中…')
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '再拆一段', type: 'text' }],
              state: 'running',
              triggerPromptId: submitted,
              turnId: 't3',
            },
          },
          { meta: { activity: 'turn' }, op: 'meta.merge' },
        ],
        12,
      ),
    )

    expect(await screen.findByRole('status')).toHaveTextContent('请求中…')
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f2', kind: 'thinking', text: '先看看已经有哪些镜头。' },
            stepId: 't3.1',
            turnId: 't3',
          },
        ],
        13,
      ),
    )

    expect(await screen.findByText('思考中…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('工作中…')
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              endedAt: '2026-08-31T03:00:05Z',
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '再拆一段', type: 'text' }],
              state: 'completed',
              triggerPromptId: submitted,
              turnId: 't3',
            },
          },
          { meta: { activity: 'idle' }, op: 'meta.merge' },
        ],
        14,
      ),
    )

    expect(await screen.findByText('思考过程')).toBeInTheDocument()
    // 防止 completed turn 提前清除 inFlight，使收尾状态回退为请求中。
    expect(screen.getByRole('status')).toHaveTextContent('工作中…')

    socket.deliver(
      opsFrame(
        [
          {
            op: 'prompt.upsert',
            prompt: {
              createdAt: '2026-08-31T03:00:00Z',
              finishedAt: '2026-08-31T03:00:05Z',
              promptId: submitted,
              status: 'completed',
            },
          },
        ],
        15,
      ),
    )

    await waitFor(() => expect(screen.queryByText('工作中…')).toBeNull())
  })

  it('气泡按 promptId 认领：同样内容但 id 不是它的轮不接替', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)
    server.use(
      http.post('*/api/conversations/c1/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        return HttpResponse.json({
          createdAt: '2026-08-31T03:00:00Z',
          promptId: body.prompt_id,
          status: 'running',
        })
      }),
    )

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getAllByText('再拆一段')).toHaveLength(1))

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '再拆一段', type: 'text' }],
              state: 'running',
              triggerPromptId: 'prm_someone_else',
              turnId: 't3',
            },
          },
        ],
        11,
      ),
    )

    // 时间线多了一份同样的字，气泡那份还在，本地也仍算在等自己那一轮。
    await waitFor(() => expect(screen.getAllByText('再拆一段')).toHaveLength(2))
    expect(screen.getByRole('status')).toHaveTextContent('请求中…')
  })

  it('点派活卡的「查看」：地址上点名这张卡的产物，右侧宿主据此打开', async () => {
    const user = userEvent.setup()
    const { router } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    await user.click(screen.getByRole('button', { name: '查看子代理过程' }))

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        artifact: 'frame:call_t2_delegate',
      }),
    )
  })

  it('发送失败把字还回输入框', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    server.use(
      http.post('*/api/conversations/c1/prompts', () =>
        HttpResponse.json({ detail: '这段对话不是你的' }, { status: 403 }),
      ),
    )

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))

    const editor = await screen.findByLabelText('输入消息')
    await waitFor(() => expect(editor).toHaveTextContent('再拆一段'))
    expect(screen.queryAllByText('再拆一段')).toHaveLength(1)
  })

  it('发出去后离开再回来，气泡和「请求中」还在：本地发送状态按对话保存，不随页面卸载', async () => {
    const user = userEvent.setup()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/conversations/c1/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        await gate
        return HttpResponse.json({
          createdAt: '2026-08-31T03:00:00Z',
          promptId: body.prompt_id,
          status: 'running',
        })
      }),
    )
    await renderWithProviders(<RemountableConversation />)
    await screen.findByText(TAIL_TEXT)

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getAllByText('再拆一段')).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: '离开' }))
    expect(screen.queryByText('再拆一段')).toBeNull()
    await user.click(screen.getByRole('button', { name: '回来' }))
    await screen.findByText(TAIL_TEXT)

    expect(screen.getAllByText('再拆一段')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('请求中…')
    release()
  })

  it('离开期间发送失败：回来时气泡已撤，也不再显示请求中', async () => {
    const user = userEvent.setup()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/conversations/c1/prompts', async () => {
        await gate
        return HttpResponse.json({ detail: '这段对话不是你的' }, { status: 403 })
      }),
    )
    await renderWithProviders(<RemountableConversation />)
    await screen.findByText(TAIL_TEXT)

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getAllByText('再拆一段')).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: '离开' }))
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await user.click(screen.getByRole('button', { name: '回来' }))
    await screen.findByText(TAIL_TEXT)

    expect(screen.queryByText('再拆一段')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('在跑的时候发送钮换成停止钮，点它停掉在跑的那条', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let aborted = ''
    server.use(
      http.post('*/api/conversations/c1/prompts/:promptId', ({ params }) => {
        aborted = String(params['promptId'])
        return new HttpResponse(null, { status: 204 })
      }),
    )

    socket.deliver(opsFrame([runningPrompt('p-run')], 11))

    const stop = await screen.findByRole('button', { name: '停止' })
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()

    await user.click(stop)

    await waitFor(() => {
      expect(aborted).toBe('p-run:abort')
    })
  })

  it('排队那条由服务端那份渲染，点「立即发送」把它插进当前这一轮', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let steered: string[] = []
    server.use(
      http.post('*/api/conversations/c1/prompts:steer', async ({ request }) => {
        const body = (await request.json()) as { prompt_ids: string[] }
        steered = body.prompt_ids
        return new HttpResponse(null, { status: 204 })
      }),
    )

    socket.deliver(opsFrame([runningPrompt('p-run'), queuedPrompt('p-queued', '顺便配个音')], 11))

    expect(await screen.findByText('顺便配个音')).toBeInTheDocument()
    expect(screen.getByText('1 个任务等待发送')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '立即发送到当前回合' }))

    await waitFor(() => {
      expect(steered).toEqual(['p-queued'])
    })
  })

  it('只有最后一轮带「重新生成」钮', async () => {
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    expect(
      within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '重新生成' }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByLabelText('第 1 轮')).queryByRole('button', { name: '重新生成' }),
    ).toBeNull()
  })

  it('点「重新生成」提交末轮的 :regenerate 请求', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let regenerated = ''
    server.use(
      http.post('*/api/conversations/c1/turns/*', ({ request }) => {
        regenerated = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
        return HttpResponse.json({
          createdAt: '2026-08-31T03:02:00Z',
          promptId: 'prm_regen_1',
          status: 'running',
        })
      }),
    )

    await user.click(
      within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '重新生成' }),
    )

    await waitFor(() => {
      expect(regenerated).toBe('t2:regenerate')
    })
  })

  it('只有末轮的开场气泡有「修改」；点了把原内容装回输入框，发送打 :regenerate 带新内容', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let path = ''
    let body: { content: { text?: string }[]; prompt_id: string } | null = null
    server.use(
      http.post('*/api/conversations/c1/turns/*', async ({ request }) => {
        path = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
        body = (await request.json()) as { content: { text?: string }[]; prompt_id: string }
        return HttpResponse.json({
          createdAt: '2026-08-31T03:02:00Z',
          promptId: body.prompt_id,
          status: 'running',
        })
      }),
    )

    expect(
      within(screen.getByLabelText('第 1 轮')).queryByRole('button', { name: '修改' }),
    ).toBeNull()
    await user.click(within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '修改' }))

    expect(screen.getByText('正在修改第 2 轮')).toBeInTheDocument()
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('第 2 个问题')

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '，再具体些')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => {
      expect(path).toBe('t2:regenerate')
    })
    const sent = body as { content: { text?: string }[]; prompt_id: string } | null
    expect(sent).not.toBeNull()
    const text = sent?.content.map((part) => part.text ?? '').join('') ?? ''
    expect(text).toContain('第 2 个问题')
    expect(text).toContain('再具体些')
    expect(sent?.prompt_id).not.toBe('')
    await waitFor(() => {
      expect(screen.queryByText('正在修改第 2 轮')).toBeNull()
    })
  })

  it('修改态点「取消」：提示条收起，输入框清空', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    await user.click(within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '修改' }))
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('第 2 个问题')

    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByText('正在修改第 2 轮')).toBeNull()
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('')
  })

  it('对话在忙时「修改」和「重新生成」都不可用', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    const latestTurn = within(screen.getByLabelText('第 2 轮'))
    const regenerate = latestTurn.getByRole('button', {
      name: '重新生成',
    })
    const edit = latestTurn.getByRole('button', { name: '修改' })
    expect(regenerate).toBeEnabled()
    expect(edit).toBeEnabled()

    socket.deliver(opsFrame([runningPrompt('p-run')], 11))

    await waitFor(() => {
      expect(regenerate).toBeDisabled()
      expect(edit).toBeDisabled()
    })
  })

  it('重新生成被服务端拒了（409）时把它给的中文文案弹出来', async () => {
    const user = userEvent.setup()
    await renderWithProviders(
      <>
        <ConversationRoute conversationId="c1" />
        <Toaster />
      </>,
    )
    await screen.findByText(TAIL_TEXT)

    server.use(
      http.post('*/api/conversations/c1/turns/*', () =>
        HttpResponse.json({ detail: '这段对话还在忙，等它收完尾再重新生成' }, { status: 409 }),
      ),
    )

    await user.click(
      within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '重新生成' }),
    )

    expect(
      await screen.findByText('重新生成失败：这段对话还在忙，等它收完尾再重新生成'),
    ).toBeInTheDocument()
  })

  it('工具结果是纯文本时可以展开；历史里的读文件卡尾写行数', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    expect(screen.getByRole('button', { name: /读取文件/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByText('3 行')).toBeInTheDocument()

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: {
              display: { kind: 'file_io', operation: 'grep', path: 'shots/' },
              frameId: 't2.1.f4',
              kind: 'tool',
              name: 'search_files',
              output: 'shots/s01.md\nshots/s02.md',
              state: 'done',
              toolCallId: 'call_grep',
            },
            stepId: 't2.1',
            turnId: 't2',
          },
        ],
        11,
      ),
    )

    const row = await screen.findByRole('button', { name: /搜索内容/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')

    await user.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/shots\/s01\.md/)).toBeInTheDocument()
  })

  it('助手正文按 markdown 渲染：列表、粗体、行内代码', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: {
              frameId: 't2.1.f8',
              kind: 'text',
              role: 'assistant',
              text: '要点：\n\n- 拆出 **3 个**镜头\n- 写进 `shots/s09.md`\n',
            },
            stepId: 't2.1',
            turnId: 't2',
          },
        ],
        11,
      ),
    )

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(screen.getByText('3 个').tagName).toBe('STRONG')
    expect(screen.getByText('shots/s09.md').tagName).toBe('CODE')
  })

  it('正文里夹的 HTML 会渲染，脚本与事件属性被摘掉', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: {
              frameId: 't2.1.f7',
              kind: 'text',
              role: 'assistant',
              text: [
                '<details><summary>展开看设定</summary>',
                '<p id="html-body">这段是 <b>HTML</b></p></details>',
                '<script>window.__pwned = true</script>',
                '<p onclick="window.__pwned = true" id="html-click">点我</p>',
              ].join('\n'),
            },
            stepId: 't2.1',
            turnId: 't2',
          },
        ],
        11,
      ),
    )

    expect(await screen.findByText('展开看设定')).toBeInTheDocument()
    expect(screen.getByText('HTML').tagName).toBe('B')
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('点我')).not.toHaveAttribute('onclick')
  })

  it('连续的思考与工具收成一行活动组，点开铺开每一条', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              endedAt: '2026-08-31T03:01:00Z',
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '拆', type: 'text' }],
              startedAt: '2026-08-31T03:00:00Z',
              state: 'completed',
              turnId: 't3',
            },
          },
          {
            op: 'step.upsert',
            step: {
              endedAt: '2026-08-31T03:01:00Z',
              kind: 'step',
              ordinal: 1,
              startedAt: '2026-08-31T03:00:00Z',
              state: 'completed',
              stepId: 't3.1',
              turnId: 't3',
            },
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f2', kind: 'thinking', text: '想' },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: {
              display: { kind: 'file_io', operation: 'read', path: 'shots/storyboard.md' },
              frameId: 't3.1.f3',
              kind: 'tool',
              name: 'read_file',
              state: 'done',
              toolCallId: 'c3a',
            },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: {
              display: { kind: 'file_io', operation: 'write', path: 'shots/storyboard.md' },
              frameId: 't3.1.f4',
              kind: 'tool',
              name: 'write_file',
              state: 'done',
              toolCallId: 'c3b',
            },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f5', kind: 'text', role: 'assistant', text: '拆好了。' },
            stepId: 't3.1',
            turnId: 't3',
          },
        ],
        11,
      ),
    )

    const head = await screen.findByRole('button', {
      name: /完成：读取了 1 个文件 · 写入了 1 个文件/,
    })
    expect(head).toHaveAttribute('aria-expanded', 'false')

    await user.click(head)

    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('shots/storyboard.md').length).toBeGreaterThan(1)
  })

  it('历史消息里的附件画成芯片，点开进灯箱', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    await user.click(await screen.findByRole('button', { name: '图片' }))

    const dialog = await screen.findByRole('dialog', { name: '图片' })
    expect(within(dialog).getByRole('img', { name: '图片' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('等审批时贴出审批卡，点「同意」打 interactions 端点', async () => {
    const user = userEvent.setup()
    serveApprovalPage()
    let decided: { body: unknown; path: string } | null = null
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', async ({ request }) => {
        decided = { body: await request.json(), path: new URL(request.url).pathname }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await renderConversation()

    const card = await screen.findByRole('region', { name: '等你审批' })
    expect(within(card).getByText('写入文件')).toBeInTheDocument()
    // 审批卡预览要写的内容，来自 display 里的 content。
    expect(within(card).getByRole('region', { name: '改动预览' })).toHaveTextContent(
      '两张镜头帧拼版，主图在左。',
    )

    await user.click(within(card).getByRole('button', { name: /同意/ }))

    await waitFor(() => {
      expect(decided).toEqual({
        body: { approved: true },
        path: '/api/conversations/c1/interactions/appr_1',
      })
    })
    // 卡片移除由服务端 pending 集合驱动，本地提交仅更新结果。
    expect(await within(card).findByText('已同意')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /拒绝/ })).toBeNull()
  })

  it('点「拒绝」发的是 approved: false', async () => {
    const user = userEvent.setup()
    serveApprovalPage()
    let body: unknown = null
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', async ({ request }) => {
        body = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await renderConversation()

    const card = await screen.findByRole('region', { name: '等你审批' })
    await user.click(within(card).getByRole('button', { name: /拒绝/ }))

    await waitFor(() => expect(body).toEqual({ approved: false }))
    expect(await within(card).findByText('已拒绝')).toBeInTheDocument()
  })

  it('改主意（409）时说清已经做过决定', async () => {
    const user = userEvent.setup()
    serveApprovalPage()
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', () =>
        HttpResponse.json({ detail: '这张卡已经做过决定了' }, { status: 409 }),
      ),
    )
    await renderWithProviders(
      <>
        <ConversationRoute conversationId="c1" />
        <Toaster />
      </>,
    )

    const card = await screen.findByRole('region', { name: '等你审批' })
    await user.click(within(card).getByRole('button', { name: /同意/ }))

    expect(await screen.findByText('已经做过决定')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /拒绝/ })).toBeInTheDocument()
  })

  it('等审批时不给追加入口，输入框改口说在等谁', async () => {
    serveApprovalPage()
    const { socket } = await renderConversation()
    await screen.findByRole('region', { name: '等你审批' })

    socket.deliver(opsFrame([queuedPrompt('p-queued', '顺便配个音')], 11))

    expect(await screen.findByText('1 个任务等待发送')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '立即发送到当前回合' })).toBeNull()
    expect(screen.getByText('等你审批后继续')).toBeInTheDocument()
  })

  it('治理者看别人的对话是只读：页头标属主，没有输入框、修改与重新生成，审批和队列只展示', async () => {
    const other = addMockUser('小王')
    loginAs(mockAuthUser, { permissions: [...mockAuthUser.permissions, 'users:manage'] })
    let decided = false
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', () => {
        decided = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    serveApprovalPage(other.id)
    const user = userEvent.setup()
    const { socket } = await renderConversation()

    expect(await screen.findByText('只读 · 小王 的对话')).toBeVisible()
    expect(screen.getByRole('note', { name: '只读说明' })).toHaveTextContent('小王')
    expect(screen.queryByLabelText('输入消息')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()

    const card = screen.getByRole('region', { name: '等你审批' })
    expect(within(card).queryByRole('button', { name: '同意' })).toBeNull()
    expect(within(card).getByText('等属主来决定')).toBeVisible()
    await user.keyboard('1')

    socket.deliver(opsFrame([queuedPrompt('p-queued', '顺便配个音')], 11))
    expect(await screen.findByText('1 个任务等待发送')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '立即发送到当前回合' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤回' })).toBeNull()
    expect(decided).toBe(false)
  })

  it('分叉不写源对话，所以只读地看着别人的也分得动；点一下把这一轮交给后端并跳到副本', async () => {
    const other = addMockUser('小王')
    loginAs(mockAuthUser, { permissions: [...mockAuthUser.permissions, 'users:manage'] })
    let asked: { turn: number } | null = null
    let calls = 0
    // 合同上这几个 id 都是 UUID；副本的 id 由服务端铸，测试里铸一个当它的答复。
    const copy = addMockConversation('开场那段（分叉 · 第 2 轮）')
    server.use(
      http.post('*/api/conversations/c1:fork', async ({ request }) => {
        calls += 1
        asked = (await request.json()) as { turn: number }
        return HttpResponse.json(
          { conversation: { ...copy, forkTurn: asked.turn, forkedFrom: crypto.randomUUID() } },
          { status: 201 },
        )
      }),
    )
    const forked = vi.fn()
    const user = userEvent.setup()
    const page = mockTranscriptPage()
    server.use(
      http.get('*/api/conversations/c1/transcript', () =>
        HttpResponse.json({ ...page, owner_user_id: other.id }),
      ),
    )
    await renderWithProviders(<ConversationRoute conversationId="c1" onForked={forked} />)

    expect(await screen.findByText('只读 · 小王 的对话')).toBeVisible()
    const buttons = await screen.findAllByRole('button', { name: '从这里分叉' })
    const button = buttons[buttons.length - 1] as HTMLElement
    // 副本的 id 由服务端铸、没有幂等键；请求回来了但还没跳走的那一瞬再点一下，不能开出两段。
    await user.dblClick(button)

    await waitFor(() => expect(forked).toHaveBeenCalledWith(copy.id))
    expect(calls).toBe(1)
    // mockTranscriptPage 的基线有两轮，点最后一轮的按钮。
    expect(asked).toEqual({ turn: 2 })
  })

  it('副本页给一条血缘提示，带着源对话的入口', async () => {
    const source = crypto.randomUUID()
    const page = mockTranscriptPage()
    server.use(
      http.get('*/api/conversations/c1/transcript', () =>
        HttpResponse.json({ ...page, fork_turn: 2, forked_from: source }),
      ),
    )
    await renderWithProviders(
      <ConversationRoute
        conversationId="c1"
        sourceLink={(sourceId) => <a href={`/c/${sourceId}`}>看源对话</a>}
      />,
    )

    const note = await screen.findByRole('note', { name: '分叉来源' })
    expect(note).toHaveTextContent('历史截到源对话第 2 轮')
    expect(within(note).getByRole('link', { name: '看源对话' })).toHaveAttribute(
      'href',
      `/c/${source}`,
    )
  })

  it('治理者看已删的对话也是只读，页头与说明都标出已删除；自己删的主语写「自己」', async () => {
    const other = addMockUser('小王')
    loginAs(mockAuthUser, { permissions: [...mockAuthUser.permissions, 'users:manage'] })
    serveApprovalPage(other.id, '2026-09-04T00:00:00Z')
    const first = await renderConversation()

    expect(await screen.findByText('已删除 · 小王 的对话')).toBeVisible()
    expect(screen.getByRole('note', { name: '只读说明' })).toHaveTextContent('小王 已删除的对话')
    expect(screen.queryByLabelText('输入消息')).toBeNull()
    first.unmount()

    serveApprovalPage(mockAuthUser.id, '2026-09-04T00:00:00Z')
    await renderConversation()

    expect(await screen.findByText('已删除 · 自己的对话')).toBeVisible()
    expect(screen.getByRole('note', { name: '只读说明' })).toHaveTextContent('这是自己已删除的对话')
    expect(screen.queryByLabelText('输入消息')).toBeNull()
  })

  it('页头的合集标签取自侧栏已拿到的拓扑：最新那份说它在哪个合集就挂哪个，说它没归类就摘掉', async () => {
    const { queryClient } = await renderConversation()
    await screen.findByText(TAIL_TEXT)
    const item = { ...addMockConversation('夜景延时素材生成'), id: 'c1' }
    const collection = addMockCollection('夏季亚麻系列')
    const topology = (grouped: boolean): SidebarTopology => ({
      collections: [
        {
          conversationCount: grouped ? 1 : 0,
          id: collection.id,
          name: collection.name,
          page: { items: grouped ? [item] : [], nextCursor: null },
          updatedAt: collection.updatedAt,
        },
      ],
      ungrouped: { items: grouped ? [] : [item], nextCursor: null },
      ungroupedCount: grouped ? 0 : 1,
    })
    expect(screen.queryByText('夏季亚麻系列')).toBeNull()

    act(() => {
      queryClient.setQueryData(conversationsQueryKeys.sidebar('all'), topology(true))
    })
    expect(screen.getByText('夏季亚麻系列')).toBeVisible()

    act(() => {
      queryClient.setQueryData(conversationsQueryKeys.sidebar('open'), topology(false), {
        updatedAt: Date.now() + 1000,
      })
    })
    expect(screen.queryByText('夏季亚麻系列')).toBeNull()
  })

  it('标题来自基线，服务端起了新名字就当场换掉', async () => {
    const { socket } = await renderConversation()

    // 历史会话可能不在侧栏首页，初始标题必须来自基线。
    expect(await screen.findByRole('heading', { name: '夜景延时素材生成' })).toBeVisible()

    socket.deliver({
      ...sessionEnvelope('c1'),
      type: 'session.meta.updated',
      payload: { session_id: 'c1', title: '改过的名字' },
    })

    expect(await screen.findByRole('heading', { name: '改过的名字' })).toBeVisible()
  })
})
