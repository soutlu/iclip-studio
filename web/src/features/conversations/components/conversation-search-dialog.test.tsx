import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { addMockConversation, loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SERVER_HELLO } from '@/testing/ws'
import type { Conversation } from '../conversations.api'
import { useLiveConversations } from '../conversations.live'
import { ConversationSearchDialog } from './conversation-search-dialog'

/** 全局帧订阅在应用里挂在侧栏顶层；弹窗自己不订，这里照壳的样子在外面挂一次。 */
function LiveFrames() {
  useLiveConversations()
  return null
}

const conversation: Conversation = {
  activity: {
    busy: false,
    lastTurnReason: null,
    pendingInteraction: 'none',
    videoGeneration: 'none',
  },
  agentId: 'storyboard',
  collectionId: null,
  completedAt: null,
  createdAt: '2026-08-01T00:00:00Z',
  deletedAt: null,
  eventEpoch: 'epoch-1',
  forkTurn: null,
  forkedFrom: null,
  id: '6d80645b-f17b-4eab-a5d2-6c72214f35f3',
  lastRunId: null,
  lastSeq: 0,
  ownerUserId: '0f7f4c1e-8a3b-4d0e-9c2a-6b1d2e3f4a5b',
  taskId: null,
  title: '亚麻衬衫二剪',
  updatedAt: '2026-08-03T00:00:00Z',
}

const openDialog = () =>
  renderWithProviders(<ConversationSearchDialog onOpenChange={vi.fn()} open />)

describe('ConversationSearchDialog', () => {
  it('把关键词交给搜索接口，按响应顺序展示结果', async () => {
    let keyword: string | null = null
    server.use(
      http.get('*/api/conversations/search', ({ request }) => {
        keyword = new URL(request.url).searchParams.get('q')
        return HttpResponse.json({
          items: [
            conversation,
            {
              ...conversation,
              id: 'd47f7c54-7f89-44b5-aec7-647c019e6efe',
              title: '夏季亚麻系列广告',
              updatedAt: '2026-08-01T00:00:00Z',
            },
          ],
        })
      }),
    )
    const user = userEvent.setup()
    await openDialog()

    expect(screen.getByText('输入关键词可搜索你的任务')).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '  亚麻  ')

    const results = await screen.findByRole('list', { name: '搜索结果' })
    expect(keyword).toBe('亚麻')
    expect(
      within(results)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['亚麻衬衫二剪', '夏季亚麻系列广告'])
  })

  it('没有命中时给一句空结果提示', async () => {
    server.use(http.get('*/api/conversations/search', () => HttpResponse.json({ items: [] })))
    const user = userEvent.setup()
    await openDialog()

    await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '亚麻')

    expect(await screen.findByText('暂无匹配的任务')).toBeVisible()
  })

  it('接口出错时把后端的错误文案就地显示出来', async () => {
    server.use(
      http.get('*/api/conversations/search', () =>
        HttpResponse.json({ detail: '搜索服务不可用' }, { status: 503 }),
      ),
    )
    const user = userEvent.setup()
    await openDialog()

    await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '亚麻')

    expect(await screen.findByText(/搜索服务不可用/)).toBeVisible()
  })

  it('重连后按原关键词重搜：断线期间改名后命中的对话出现在结果里', async () => {
    loginAs(mockAuthUser)
    addMockConversation('亚麻衬衫二剪')
    const renamed = addMockConversation('秋季外套')
    const user = userEvent.setup()
    const { socket } = await renderWithProviders(
      <>
        <LiveFrames />
        <ConversationSearchDialog onOpenChange={vi.fn()} open />
      </>,
    )
    const titles = () =>
      within(screen.getByRole('list', { name: '搜索结果' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
        .sort()

    await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '亚麻')
    await screen.findByRole('list', { name: '搜索结果' })
    expect(titles()).toEqual(['亚麻衬衫二剪'])

    // 断线期间别处把另一段改了名；全局帧不补发，改名帧丢了。
    socket.onclose?.()
    renamed.title = '亚麻长裙'
    // 第一次重连排在 1 秒退避（另加至多 250ms 抖动）之后，握手完成才算重连上。
    await act(() => new Promise((resolve) => setTimeout(resolve, 1300)))
    socket.deliver(SERVER_HELLO)

    await waitFor(() => expect(titles()).toEqual(['亚麻衬衫二剪', '亚麻长裙'].sort()))
  }, 10_000)
})
