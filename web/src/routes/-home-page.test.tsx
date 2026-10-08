import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { pasteTextIntoComposer } from '@/testing/editor'
import {
  addMockCollection,
  liveMockConversation,
  loginAs,
  mockAuthUser,
  mockCollections,
  mockConversations,
} from '@/testing/mocks/handlers'
import { mockLibraryVideos } from '@/testing/mocks/library'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { HomePage } from './-home-page'
import { LoginPromptProvider } from './-login-prompt'

const renderHome = async (initialPath = '/') => {
  const rendered = await renderWithProviders(
    <LoginPromptProvider value={() => undefined}>
      <Toaster />
      <HomePage />
    </LoginPromptProvider>,
    { initialPath },
  )
  return { ...rendered, user: userEvent.setup() }
}

afterEach(() => {
  toast.dismiss()
})

const liveConversations = () => mockConversations.filter((item) => item.deletedAt === null)

const promptReceipt = (promptId: string) =>
  HttpResponse.json({ createdAt: new Date().toISOString(), promptId, status: 'queued' })

describe('首页真实数据流程', () => {
  it('新建合集后立即选中；选择服务端 Agent 并将合集带入首条创作', async () => {
    loginAs(mockAuthUser)
    server.use(
      http.get('*/api/conversations/agents', () =>
        HttpResponse.json({
          items: [{ id: 'new-agent', name: 'new-agent' }],
          default: 'new-agent',
        }),
      ),
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByText('new-agent')
    await user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    await user.type(screen.getByRole('combobox', { name: '搜索合集' }), '秋季短片')
    await user.click(screen.getByRole('button', { name: '新建“秋季短片”' }))
    const nameInput = await screen.findByRole('textbox', { name: '合集名称' })
    expect(nameInput).toHaveValue('秋季短片')
    // 打开即可输入：焦点在名称框，不在表头的关闭按钮上；离上限远时不显示字数。
    await waitFor(() => expect(nameInput).toHaveFocus())
    expect(screen.queryByText(/\/200$/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '关联合集：秋季短片' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '制作秋季宣传片')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(mockCollections).toHaveLength(1)
    expect(mockConversations).toHaveLength(1)
    expect(mockConversations[0]).toMatchObject({
      agentId: 'new-agent',
      collectionId: mockCollections[0]?.id,
    })
  })

  it.each([
    ['自己的合集', true, '关联合集：夏季亚麻系列'],
    ['不在自己合集里的 id', false, '关联合集：未关联合集'],
  ])('查询串带来%s：预选或退回无关联，之后从地址栏移除', async (_, known, picker) => {
    loginAs(mockAuthUser)
    const collection = addMockCollection('夏季亚麻系列')
    const requested = known ? collection.id : crypto.randomUUID()
    const { router, user } = await renderHome(`/?collection=${requested}`)

    expect(await screen.findByRole('button', { name: picker })).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    // 合集已读到、参数已移除，选择照旧，不被打回。
    await user.click(screen.getByRole('button', { name: picker }))
    expect(await screen.findByRole('combobox', { name: '搜索合集' })).toBeVisible()
    expect(screen.getAllByText('夏季亚麻系列').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: picker })).toBeInTheDocument()
  })

  it('首条消息回执失败时保留输入；重试复用同一对话与消息编号', async () => {
    loginAs(mockAuthUser)
    const bodies: { prompt_id: string; content: unknown[] }[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as (typeof bodies)[number]
        bodies.push(body)
        return bodies.length === 1
          ? HttpResponse.json({ detail: '发送回执中断' }, { status: 503 })
          : promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '保留我的原稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(router.state.location.pathname).toBe('/')
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('保留我的原稿')
    expect(mockConversations).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/c/${mockConversations[0]?.id}`),
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(mockConversations).toHaveLength(1)
  })

  it('创建回执失败后用同一对话编号重试，创建成功前不发消息', async () => {
    loginAs(mockAuthUser)
    const ids: string[] = []
    let sends = 0
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/conversations') {
        const body = (await request.clone().json()) as { id: string }
        ids.push(body.id)
      }
    })
    server.use(
      http.post(
        '*/api/conversations',
        () => HttpResponse.json({ detail: '创建回执中断' }, { status: 503 }),
        { once: true },
      ),
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        sends += 1
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '创建后发送')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(ids).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(sends).toBe(0)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(mockConversations[0]?.id).toBe(ids[0])
    expect(sends).toBe(1)
  })

  it.each([
    {
      scene: '只有一个可用助手时只显示名字',
      items: [{ id: 'only', name: '分镜策划' }],
      picker: false,
    },
    {
      scene: '多个可用助手时仍是下拉',
      items: [
        { id: 'only', name: '分镜策划' },
        { id: 'replica', name: '视频复刻' },
      ],
      picker: true,
    },
  ])('$scene', async ({ items, picker }) => {
    loginAs(mockAuthUser)
    server.use(
      http.get('*/api/conversations/agents', () => HttpResponse.json({ items, default: 'only' })),
    )
    const { user } = await renderHome()
    expect(await screen.findByText('分镜策划')).toBeVisible()
    const trigger = screen.queryByRole('button', { name: '分镜策划' })
    if (!picker) {
      expect(trigger).not.toBeInTheDocument()
      return
    }
    if (trigger === null) throw new Error('多个助手时应有下拉按钮')
    await user.click(trigger)
    expect(await screen.findByRole('menuitem', { name: '视频复刻' })).toBeVisible()
  })

  it('Agent 目录读取失败可重试，空目录不会创建对话', async () => {
    loginAs(mockAuthUser)
    server.use(
      http.get(
        '*/api/conversations/agents',
        () => HttpResponse.json({ detail: '目录读取失败' }, { status: 503 }),
        { once: true },
      ),
      http.get('*/api/conversations/agents', () => HttpResponse.json({ items: [], default: null })),
    )
    const { user } = await renderHome()
    await user.click(await screen.findByRole('button', { name: '创作助手加载失败' }))
    await user.click(screen.getByRole('menuitem', { name: '重新加载' }))
    await screen.findByRole('button', { name: '暂无可用的创作助手' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '暂存内容')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(mockConversations).toHaveLength(0)
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('暂存内容')
  })

  it('失败后对话被删除，明确收到 404 后的下一次主动提交使用新编号', async () => {
    loginAs(mockAuthUser)
    const targets: string[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ params, request }) => {
        const target = String(params['conversationId'])
        targets.push(target)
        if (!liveMockConversation(target)) {
          return HttpResponse.json({ detail: '对话已不存在' }, { status: 404 })
        }
        if (targets.length === 1)
          return HttpResponse.json({ detail: '暂时无法发送' }, { status: 503 })
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '保留这份原稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(targets).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    const removed = mockConversations[0]
    if (!removed) throw new Error('首次提交没有创建对话')
    await fetch(`/api/conversations/${removed.id}`, { method: 'DELETE' })
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(targets).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(router.state.location.pathname).toBe('/')
    // 删除留下墓碑（合同 §6），只数活着的对话。
    expect(liveConversations()).toHaveLength(0)
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('保留这份原稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(targets[1]).toBe(removed.id)
    expect(targets[2]).not.toBe(removed.id)
    expect(liveConversations()).toHaveLength(1)
  })
})

describe('首页做同款', () => {
  const SAME_PLACEHOLDER = '照这条视频做同款，想换成什么？'
  const PHRASES = ['换人物', '换产品', '换场景']
  /** 测试用户自己的卡，mock 里做得了同款。 */
  const sourceCard = () => {
    const card = mockLibraryVideos().find((video) => video.title === '跑鞋手持展示')
    if (card === undefined) throw new Error('mock 里没有这张卡')
    return card
  }

  /** 记下每次建对话的请求体。 */
  const recordCreateBodies = () => {
    const bodies: { id: string; sameAs?: string }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/conversations') {
        bodies.push((await request.clone().json()) as (typeof bodies)[number])
      }
    })
    return bodies
  }

  const acceptPrompts = () =>
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )

  it('查询串带来的卡换掉首页 hero、输入框带快捷词，参数从地址栏移除；✕ 回到普通首页', async () => {
    loginAs(mockAuthUser)
    const { router, user } = await renderHome(`/?same=${sourceCard().id}`)

    expect(await screen.findByText('跑鞋手持展示')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Cue' })).not.toBeInTheDocument()
    expect(screen.getByText(SAME_PLACEHOLDER)).toBeInTheDocument()
    for (const phrase of PHRASES) {
      expect(screen.getByRole('button', { name: phrase })).toBeVisible()
    }
    await waitFor(() => expect(router.state.location.search).toEqual({}))

    await user.click(screen.getByRole('button', { name: '不做同款' }))
    expect(screen.getByRole('heading', { name: 'Cue' })).toBeInTheDocument()
    expect(screen.queryByText('跑鞋手持展示')).not.toBeInTheDocument()
    expect(screen.queryByText(SAME_PLACEHOLDER)).not.toBeInTheDocument()
    for (const phrase of PHRASES) {
      expect(screen.queryByRole('button', { name: phrase })).not.toBeInTheDocument()
    }
  })

  it('快捷词插到光标处并聚焦输入框', async () => {
    loginAs(mockAuthUser)
    const { user } = await renderHome(`/?same=${sourceCard().id}`)
    const editor = screen.getByLabelText('输入消息')

    await user.click(await screen.findByRole('button', { name: '换产品' }))
    expect(editor).toHaveTextContent('把产品换成')
    expect(editor).toHaveFocus()
    await user.keyboard('黑色跑鞋')
    await user.click(screen.getByRole('button', { name: '换场景' }))
    expect(editor).toHaveTextContent('把产品换成黑色跑鞋把场景换成')
  })

  it('助手预选源视频用的那个，仍可改选', async () => {
    loginAs(mockAuthUser)
    const card = sourceCard()
    server.use(
      http.get('*/api/library/videos/:id', () =>
        HttpResponse.json({
          canMakeSame: true,
          groups: [{ shotIndex: 1, versions: [{ ...card.face, take: card.take }] }],
          video: { ...card, agentId: 'replica' },
        }),
      ),
    )
    const { user } = await renderHome(`/?same=${card.id}`)

    await user.click(await screen.findByRole('button', { name: '完全复刻' }))
    await user.click(await screen.findByRole('menuitem', { name: '分镜 Agent' }))
    expect(await screen.findByRole('button', { name: '分镜 Agent' })).toBeVisible()
  })

  it('建对话带上 sameAs，回执丢了重发仍是同一段对话', async () => {
    loginAs(mockAuthUser)
    const card = sourceCard()
    const bodies = recordCreateBodies()
    acceptPrompts()
    server.use(
      http.post(
        '*/api/conversations',
        () => HttpResponse.json({ detail: '创建回执中断' }, { status: 503 }),
        { once: true },
      ),
    )
    const { router, user } = await renderHome(`/?same=${card.id}`)
    await screen.findByText('跑鞋手持展示')
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '把人物换成短发男生')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '不做同款' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/c/${mockConversations[0]?.id}`),
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ sameAs: card.id })
    expect(bodies[1]).toEqual(bodies[0])
  })

  it('建对话被拒时提示服务端原因并留在做同款；✕ 后再发是另一段对话，不带 sameAs', async () => {
    loginAs(mockAuthUser)
    const card = sourceCard()
    const bodies = recordCreateBodies()
    acceptPrompts()
    server.use(
      http.post(
        '*/api/conversations',
        () => HttpResponse.json({ detail: '源对话里没有工程文件或分镜文件' }, { status: 422 }),
        { once: true },
      ),
    )
    const { router, user } = await renderHome(`/?same=${card.id}`)
    await screen.findByText('跑鞋手持展示')
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '把人物换成短发男生')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText(/源对话里没有工程文件或分镜文件/)).toBeVisible()
    expect(screen.getByRole('button', { name: '不做同款' })).toBeVisible()
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('把人物换成短发男生')
    expect(router.state.location.pathname).toBe('/')

    await user.click(screen.getByRole('button', { name: '不做同款' }))
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ sameAs: card.id })
    expect(bodies[1]?.id).not.toBe(bodies[0]?.id)
    expect(bodies[1]).not.toHaveProperty('sameAs')
  })

  it.each([
    {
      scene: '读不到这张卡',
      id: () => crypto.randomUUID(),
      message: /资料库里没有这条视频/,
    },
    {
      scene: '这张卡做不了同款',
      // 别人的卡，mock 里打不开那段对话。
      id: () => mockLibraryVideos().find((video) => video.title === '春夏凉鞋合集')?.id,
      message: /该视频没有可用的制作文件，无法做同款/,
    },
  ])('$scene：提示原因并回到普通首页', async ({ id, message }) => {
    loginAs(mockAuthUser)
    await renderHome(`/?same=${id()}`)

    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Cue' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '不做同款' })).not.toBeInTheDocument()
    expect(screen.queryByText(SAME_PLACEHOLDER)).not.toBeInTheDocument()
  })
})
