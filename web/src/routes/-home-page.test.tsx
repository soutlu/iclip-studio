import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import {
  addMockCollection,
  liveMockConversation,
  loginAs,
  mockAuthUser,
  mockCollections,
  mockConversations,
  mockGovernor,
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

// 首页草稿存在 sessionStorage，同一文件的用例之间不能串。
beforeEach(() => {
  sessionStorage.clear()
})
afterEach(() => {
  toast.dismiss()
  vi.unstubAllGlobals()
  sessionStorage.clear()
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
  const SAME_PLACEHOLDER = '参照该视频做同款，请输入要替换的内容'
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

describe('首页草稿', () => {
  /** 草稿在 sessionStorage 里的位置；坏数据与删除都直接看它。 */
  const DRAFT_KEY = 'cue:home-draft-v1'
  const editor = () => screen.getByLabelText('输入消息')
  const imageFile = () => new File(['fake-png-bytes'], '参考图.png', { type: 'image/png' })

  // jsdom 不解码图片；附件上传前的尺寸校验读这个桩。
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })

  it('正文与传好的附件离开首页后保留，回来恢复且不重新上传；恢复不删草稿', async () => {
    loginAs(mockAuthUser)
    const first = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(editor(), '参照这张图做宣传片')
    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    first.unmount()

    const signs: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === '/api/uploads/sign') signs.push(request.url)
    })
    for (let visit = 0; visit < 2; visit += 1) {
      const back = await renderHome()
      expect(editor()).toHaveTextContent('参照这张图做宣传片')
      expect(within(editor()).getByText('参考图.png')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
      back.unmount()
    }
    expect(signs).toHaveLength(0)
  })

  it('上传中的附件不进草稿，正文照常保留', async () => {
    loginAs(mockAuthUser)
    server.use(
      http.post('*/api/uploads/sign', async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    const first = await renderHome()
    pasteTextIntoComposer(editor(), '附件还在上传')
    pasteFilesIntoComposer(editor(), [imageFile()])
    expect(await within(editor()).findByText('参考图.png')).toBeInTheDocument()
    first.unmount()

    await renderHome()
    expect(editor()).toHaveTextContent('附件还在上传')
    expect(within(editor()).queryByText('参考图.png')).not.toBeInTheDocument()
  })

  it('所选助手与合集离开首页后恢复；换了登录人只恢复正文，选择退回默认', async () => {
    loginAs(mockAuthUser)
    addMockCollection('夏季亚麻系列')
    const first = await renderHome()
    await first.user.click(await screen.findByRole('button', { name: '分镜 Agent' }))
    await first.user.click(await screen.findByRole('menuitem', { name: '完全复刻' }))
    await first.user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    await first.user.click(await screen.findByRole('option', { name: /夏季亚麻系列/ }))
    expect(
      await screen.findByRole('button', { name: '关联合集：夏季亚麻系列' }),
    ).toBeInTheDocument()
    pasteTextIntoComposer(editor(), '秋季上新')
    first.unmount()

    const back = await renderHome()
    expect(await screen.findByRole('button', { name: '完全复刻' })).toBeVisible()
    expect(
      await screen.findByRole('button', { name: '关联合集：夏季亚麻系列' }),
    ).toBeInTheDocument()
    expect(editor()).toHaveTextContent('秋季上新')
    back.unmount()

    loginAs(mockGovernor)
    const other = await renderHome()
    expect(await screen.findByRole('button', { name: '分镜 Agent' })).toBeVisible()
    expect(editor()).toHaveTextContent('秋季上新')
    // 合集列表读到之后（新登录人也看得到这个合集）仍是未关联。
    await other.user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    expect(await screen.findByRole('option', { name: /夏季亚麻系列/ })).toBeVisible()
    expect(screen.getByRole('button', { name: '关联合集：未关联合集' })).toBeInTheDocument()
  })

  it('草稿里的助手已不在可选列表里时明示不可用并挡住发送；改选后可以发送', async () => {
    loginAs(mockAuthUser)
    const first = await renderHome()
    await first.user.click(await screen.findByRole('button', { name: '分镜 Agent' }))
    await first.user.click(await screen.findByRole('menuitem', { name: '完全复刻' }))
    await screen.findByRole('button', { name: '完全复刻' })
    first.unmount()

    server.use(
      http.get('*/api/conversations/agents', () =>
        HttpResponse.json({
          items: [{ id: 'storyboard', name: '分镜 Agent' }],
          default: 'storyboard',
        }),
      ),
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { router, user } = await renderHome()
    const trigger = await screen.findByRole('button', { name: '所选创作助手已不可用' })
    pasteTextIntoComposer(editor(), '换个助手再发')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('请先选择可用的创作助手')).toBeVisible()
    expect(mockConversations).toHaveLength(0)
    expect(router.state.location.pathname).toBe('/')
    expect(editor()).toHaveTextContent('换个助手再发')

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: '分镜 Agent' }))
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(mockConversations[0]).toMatchObject({ agentId: 'storyboard' })
  })

  it('发送成功后删掉草稿，之后不再写回', async () => {
    loginAs(mockAuthUser)
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { router, user, unmount } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(editor(), '发出去就不留')
    await waitFor(() => expect(sessionStorage.getItem(DRAFT_KEY)).toContain('发出去就不留'))
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    await waitFor(() => expect(editor().textContent).toBe(''))
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull()
    unmount()

    await renderHome()
    expect(editor().textContent).toBe('')
  })

  it('发送失败保留草稿，离开首页再回来仍在', async () => {
    loginAs(mockAuthUser)
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', () =>
        HttpResponse.json({ detail: '暂时无法发送' }, { status: 503 }),
      ),
    )
    const { user, unmount } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(editor(), '没发出去要留着')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/暂时无法发送/)).toBeVisible()
    expect(sessionStorage.getItem(DRAFT_KEY)).toContain('没发出去要留着')
    unmount()

    await renderHome()
    expect(editor()).toHaveTextContent('没发出去要留着')
  })

  it('游客点发送去登录，整页登录返回后恢复正文', async () => {
    const guest = await renderHome()
    pasteTextIntoComposer(editor(), '登录后继续制作产品宣传片')
    await guest.user.click(screen.getByRole('button', { name: '发送' }))
    expect(editor()).toHaveTextContent('登录后继续制作产品宣传片')
    guest.unmount()

    loginAs(mockAuthUser)
    await renderHome()
    expect(editor()).toHaveTextContent('登录后继续制作产品宣传片')
    expect(await screen.findByRole('button', { name: '发送' })).toBeEnabled()
  })

  it.each([
    ['不是 JSON', '{"parts":'],
    ['形状不对', JSON.stringify({ parts: [{ kind: 'text' }], agent: null, collection: null })],
  ])('存储里的草稿%s：提示读取失败并从空白开始', async (_, raw) => {
    loginAs(mockAuthUser)
    sessionStorage.setItem(DRAFT_KEY, raw)
    await renderHome()

    expect(await screen.findByText('首页草稿读取失败，请重新输入创作要求')).toBeVisible()
    expect(editor().textContent).toBe('')
    expect(await screen.findByRole('button', { name: '分镜 Agent' })).toBeVisible()
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBe(raw)
  })

  it('暂存失败只提示一次，输入照常保留', async () => {
    loginAs(mockAuthUser)
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('storage unavailable', 'QuotaExceededError')
      },
    })
    await renderHome()
    pasteTextIntoComposer(editor(), '第一段')
    pasteTextIntoComposer(editor(), '第二段')

    const notice = '输入内容暂存失败，离开首页或登录前请先复制输入内容'
    expect(await screen.findByText(notice)).toBeVisible()
    await waitFor(() => expect(editor()).toHaveTextContent('第一段第二段'))
    expect(screen.getAllByText(notice)).toHaveLength(1)
  })
})
