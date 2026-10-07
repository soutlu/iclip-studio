import { useRouterState } from '@tanstack/react-router'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ShellChromeContext } from '@/shared/shell'
import {
  addMockCollection,
  addMockConversation,
  addMockTask,
  loginAs,
  mockAuthUser,
  mockCollections,
} from '@/testing/mocks/handlers'
import { renderWithProviders } from '@/testing/render'
import { AppSidebar } from './-app-sidebar'
import { HomePage } from './-home-page'
import { LoginPromptProvider } from './-login-prompt'

/** 测试壳持有折叠状态，与应用壳的状态归属一致。 */
function SidebarHarness({ compact = false }: { compact?: boolean }) {
  const [collapsed, setCollapsed] = useState(true)
  return <AppSidebar collapsed={collapsed} compact={compact} onCollapsedChange={setCollapsed} />
}

/** 与应用壳一样持有首页输入框的聚焦请求，首页路径下挂上首页。 */
function ShellHarness({ compact }: { compact: boolean }) {
  const [collapsed, setCollapsed] = useState(true)
  const [pending, setPending] = useState(false)
  const request = useCallback(() => setPending(true), [])
  const consume = useCallback(() => setPending(false), [])
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <ShellChromeContext
      value={{ sidebarOverlay: compact, composerFocus: { pending, request, consume } }}
    >
      <AppSidebar collapsed={collapsed} compact={compact} onCollapsedChange={setCollapsed} />
      {pathname === '/' ? <HomePage /> : null}
    </ShellChromeContext>
  )
}

const renderShell = (initialPath: string, compact = false) =>
  renderWithProviders(
    <LoginPromptProvider value={vi.fn()}>
      <ShellHarness compact={compact} />
    </LoginPromptProvider>,
    { initialPath },
  )

const renderSidebar = (requireLogin = vi.fn(), initialPath = '/', compact = false) =>
  renderWithProviders(
    <LoginPromptProvider value={requireLogin}>
      <SidebarHarness compact={compact} />
    </LoginPromptProvider>,
    { initialPath },
  )

describe('AppSidebar', () => {
  it('桌面折叠为图标栏时保留操作图标与账户入口，展开后显示完整侧边栏', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    expect(screen.getByRole('complementary')).toBeVisible()

    for (const name of ['新建任务', '搜索', '需求单', '资料库', '登录']) {
      expect(screen.getByRole('button', { name })).toBeVisible()
    }
    expect(await screen.findByText('登录后查看任务')).not.toBeVisible()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByRole('complementary')).toBeVisible()
    expect(screen.getByRole('button', { name: '新建任务' })).toBeVisible()
    expect(screen.getByRole('button', { name: '搜索' })).toBeVisible()
    expect(screen.getByRole('button', { name: '需求单' })).toBeVisible()
    expect(screen.getByRole('button', { name: '资料库' })).toBeVisible()
  })

  it('移动端展开后可再次折叠，只保留悬浮展开按钮', async () => {
    const user = userEvent.setup()
    await renderSidebar(vi.fn(), '/', true)

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    expect(screen.getByRole('button', { name: '折叠侧边栏' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toHaveFocus()

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  })

  it.each([false, true])('路由切换只折叠抽屉，搜索不折叠侧边栏，compact=%s', async (compact) => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const { router } = await renderSidebar(vi.fn(), '/', compact)
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })

    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByRole('dialog', { name: '搜索任务' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '折叠侧边栏' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '需求单' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    expect(
      screen.getByRole('button', { name: compact ? '展开侧边栏' : '折叠侧边栏' }),
    ).toBeVisible()
    if (compact) {
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
      expect(screen.getByRole('complementary')).toBeVisible()
    }
  })

  it('未登录时对话区与账户区退成登录入口，点操作即请求登录', async () => {
    const user = userEvent.setup()
    const requireLogin = vi.fn()
    await renderSidebar(requireLogin)

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByText('登录后查看任务')).toBeVisible()
    expect(screen.queryByRole('button', { name: '用户菜单' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(requireLogin).toHaveBeenCalledTimes(2)
  })

  it('已登录时点搜索打开搜对话弹窗', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    await renderSidebar()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    await user.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByRole('dialog', { name: '搜索任务' })).toBeVisible()
  })

  it('已登录时点新建任务回首页', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const { router } = await renderSidebar(vi.fn(), '/tasks')

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    // 等待 /users/me 完成，避免新建任务仍触发登录弹窗。
    await screen.findByRole('button', { name: '用户菜单' })
    await user.click(screen.getByRole('button', { name: '新建任务' }))

    expect(router.state.location.pathname).toBe('/')
  })

  it.each([false, true])('已在首页时点新建任务，输入框获得焦点，compact=%s', async (compact) => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    await renderShell('/', compact)
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })

    await user.click(screen.getByRole('button', { name: '新建任务' }))

    await waitFor(() => expect(screen.getByLabelText('输入消息')).toHaveFocus())
    // 紧凑屏的抽屉随之收起，焦点仍留在输入框。
    if (compact) expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByLabelText('输入消息')).toHaveFocus()
  })

  it.each([
    ['/tasks', false],
    ['/', true],
  ] as const)(
    '从 %s 点合集行上的「在合集里新建任务」：首页预选这个合集，输入框获得焦点，地址栏不留参数，compact=%s',
    async (initialPath, compact) => {
      loginAs(mockAuthUser)
      addMockCollection('夏季亚麻系列')
      const user = userEvent.setup()
      const { router } = await renderShell(initialPath, compact)
      await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

      await user.click(await screen.findByRole('button', { name: '在「夏季亚麻系列」里新建任务' }))

      await waitFor(() => expect(router.state.location.pathname).toBe('/'))
      expect(
        await screen.findByRole('button', { name: '关联合集：夏季亚麻系列' }),
      ).toBeInTheDocument()
      await waitFor(() => expect(screen.getByLabelText('输入消息')).toHaveFocus())
      await waitFor(() => expect(router.state.location.search).toEqual({}))
      // 紧凑屏已在首页时路由不变，抽屉照样收起。
      if (compact) expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    },
  )

  it('在其他页面按 Ctrl+Alt+N，进首页后输入框获得焦点，之后再进首页不再抢焦点', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const { router } = await renderShell('/tasks')
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    expect(screen.queryByLabelText('输入消息')).not.toBeInTheDocument()

    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}')

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    await waitFor(() => expect(screen.getByLabelText('输入消息')).toHaveFocus())

    await user.click(screen.getByRole('button', { name: '需求单' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    await router.navigate({ to: '/' })
    expect(await screen.findByLabelText('输入消息')).not.toHaveFocus()
  })

  it.each(['Meta', 'Control'])(
    '侧栏收起时 %s+K 打开搜索，选中结果跳转并关闭弹窗',
    async (modifier) => {
      loginAs(mockAuthUser)
      const conversation = addMockConversation('待找回的广告')
      const user = userEvent.setup()
      const { router } = await renderSidebar()
      await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
      await screen.findByRole('button', { name: '用户菜单' })
      await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))

      await user.keyboard(`{${modifier}>}k{/${modifier}}`)
      const dialog = await screen.findByRole('dialog', { name: '搜索任务' })
      expect(screen.getByRole('button', { name: '展开侧边栏', hidden: true })).toBeInTheDocument()
      await user.type(within(dialog).getByRole('textbox', { name: '搜索任务' }), '广告')
      const result = await within(dialog).findByRole('link', { name: conversation.title })

      if (modifier === 'Meta') {
        await user.click(result)
      } else {
        await user.tab()
        expect(result).toHaveFocus()
        await user.keyboard('{Enter}')
      }

      await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${conversation.id}`))
      expect(screen.queryByRole('dialog', { name: '搜索任务' })).not.toBeInTheDocument()
    },
  )

  it.each(['Meta', 'Control'])('%s+Alt+N 在已登录时回首页，不展开已折叠侧栏', async (modifier) => {
    loginAs(mockAuthUser)
    const conversation = addMockConversation('当前对话')
    const user = userEvent.setup()
    const { router } = await renderSidebar(vi.fn(), `/c/${conversation.id}`)
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))

    await user.keyboard(`{${modifier}>}{Alt>}n{/Alt}{/${modifier}}`)

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(screen.getByRole('complementary')).toBeVisible()
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  })

  it.each([true, false])(
    '折叠状态为 %s 时按权限置灰入口：点击与快捷键都不打开搜索或离开当前页，悬停说明原因',
    async (collapsed) => {
      loginAs(mockAuthUser, { permissions: ['tasks:read'] })
      const user = userEvent.setup()
      const { router } = await renderSidebar(vi.fn(), '/tasks')
      if (!collapsed) await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
      await screen.findByRole('button', { name: '用户菜单' })

      const search = screen.getByRole('button', { name: '搜索' })
      const library = screen.getByRole('button', { name: '资料库' })
      expect(search).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getByRole('button', { name: '新建任务' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      expect(screen.getByRole('button', { name: '需求单' })).not.toHaveAttribute('aria-disabled')
      expect(library).toHaveAttribute('aria-disabled', 'true')
      if (!collapsed) expect(screen.getByText('当前账号没有查看任务权限')).toBeVisible()

      await user.click(search)
      await user.click(library)
      await user.keyboard('{Control>}k{/Control}')
      await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}')

      expect(screen.queryByRole('dialog', { name: '搜索任务' })).not.toBeInTheDocument()
      expect(router.state.location.pathname).toBe('/tasks')

      await user.hover(library)
      expect(await screen.findByRole('tooltip')).toHaveTextContent('当前账号没有查看出片记录权限')
    },
  )

  it('置灰的入口按 Tab 移上去也说明原因，按 Enter 不触发', async () => {
    loginAs(mockAuthUser, { permissions: ['tasks:read'] })
    const user = userEvent.setup()
    const { router } = await renderSidebar(vi.fn(), '/tasks')
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })

    const library = screen.getByRole('button', { name: '资料库' })
    screen.getByRole('button', { name: '需求单' }).focus()
    await user.tab()
    expect(library).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('当前账号没有查看出片记录权限')
    await user.keyboard('{Enter}')
    expect(router.state.location.pathname).toBe('/tasks')
  })

  it('图标栏悬停图标在右侧提示名字，带快捷键的跟在后面；展开后可用的行不再弹提示', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    await renderSidebar()
    await screen.findByRole('button', { name: '用户菜单' })

    await user.hover(screen.getByRole('button', { name: '搜索' }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('搜索任务')
    expect(tip).toHaveTextContent('⌘K')

    // jsdom 没有几何，移开时 Radix 的悬停宽限区收不起上一条提示，先按 Esc 关掉。
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    await user.hover(screen.getByRole('button', { name: '需求单' }))
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(/^需求单$/))

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await user.hover(screen.getByRole('button', { name: '资料库' }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('能看出片记录的账号点资料库去 /library', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const { router } = await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })

    await user.click(screen.getByRole('button', { name: '资料库' }))

    expect(router.state.location.pathname).toBe('/library')
  })

  it('只有带 users:manage 的账号看得到「治理」组的「全部任务」「审计」入口，分别去 /conversations 与 /audit', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const plain = await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    expect(screen.queryByRole('group', { name: '治理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部任务' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '审计' })).not.toBeInTheDocument()
    plain.unmount()

    loginAs(mockAuthUser, { permissions: [...mockAuthUser.permissions, 'users:manage'] })
    const { router } = await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    const govern = screen.getByRole('group', { name: '治理' })
    expect(within(govern).getByRole('button', { name: '全部任务' })).toBeVisible()
    expect(within(govern).getByRole('button', { name: '审计' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeVisible()
    await user.click(await screen.findByRole('button', { name: '全部任务' }))
    expect(router.state.location.pathname).toBe('/conversations')

    await user.click(await screen.findByRole('button', { name: '审计' }))
    expect(router.state.location.pathname).toBe('/audit')
  })
})

describe('AppSidebar 对话区', () => {
  const openSidebar = async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    return user
  }

  it('拓扑分成「合集」与「任务」两区，合集在上，展开后露出里面的对话', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    addMockConversation('没归类的那段')
    addMockConversation('合集里的那段').collectionId = collection.id
    const user = await openSidebar()

    expect(await screen.findByRole('heading', { name: '任务' })).toBeVisible()
    expect(
      screen.getAllByRole('heading', { name: /^(合集|任务)$/ }).map((one) => one.textContent),
    ).toEqual(['合集', '任务'])
    expect(screen.getByText('没归类的那段')).toBeVisible()
    expect(screen.queryByText('合集里的那段')).not.toBeInTheDocument()
    const collectionRow = screen.getByRole('button', { name: '夏季亚麻系列 (1)' })
    expect(collectionRow).toHaveAttribute('aria-expanded', 'false')

    await user.click(collectionRow)

    expect(collectionRow).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('合集里的那段')).toBeVisible()

    await user.click(collectionRow)

    expect(collectionRow).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('合集里的那段')).not.toBeInTheDocument()
  })

  it.each([false, true])('折叠再展开保留合集展开与对话节点，compact=%s', async (compact) => {
    loginAs(mockAuthUser)
    const collection = addMockCollection('保持展开的合集')
    addMockConversation('保持位置的对话').collectionId = collection.id
    const user = userEvent.setup()
    await renderSidebar(vi.fn(), '/', compact)
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await user.click(await screen.findByRole('button', { name: '保持展开的合集 (1)' }))
    const conversation = screen.getByRole('link', { name: '保持位置的对话' })

    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))
    expect(conversation).toBeInTheDocument()
    expect(conversation).not.toBeVisible()
    expect(conversation.closest('[inert]')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByRole('link', { name: '保持位置的对话' })).toBe(conversation)
    expect(conversation).toBeVisible()
  })

  it('「+」在合集区顶部插入一行原位编辑，回车新建后换成合集行', async () => {
    const user = await openSidebar()
    await screen.findByText('还没有合集')

    await user.click(screen.getByRole('button', { name: '新建合集' }))
    const draft = screen.getByRole('textbox', { name: '新合集名称' })
    expect(draft).toHaveFocus()
    expect(screen.queryByText('还没有合集')).not.toBeInTheDocument()
    await user.type(draft, '春季童鞋{Enter}')

    // 回车建成后焦点交给新合集那一行。
    expect(await screen.findByRole('button', { name: '春季童鞋 (0)' })).toHaveFocus()
    expect(screen.queryByRole('textbox', { name: '新合集名称' })).not.toBeInTheDocument()
    expect(mockCollections.map((item) => item.name)).toEqual(['春季童鞋'])
  })

  it('合集行菜单可以改名，也可以删掉——删掉不带走里面的对话', async () => {
    const collection = addMockCollection('待改名')
    addMockConversation('里面的对话').collectionId = collection.id
    const user = await openSidebar()
    await screen.findByRole('button', { name: '待改名 (1)' })

    await user.click(screen.getByRole('button', { name: '待改名 的操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    // 原位编辑：原名全选，直接输入即替换。
    const input = await screen.findByRole('textbox', { name: '重命名 待改名' })
    expect(input).toHaveFocus()
    await user.keyboard('改好了{Enter}')
    expect(await screen.findByRole('button', { name: '改好了 (1)' })).toHaveFocus()
    expect(screen.queryByRole('textbox', { name: '重命名 待改名' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '改好了 的操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除合集' })).getByRole('button', {
        name: '删除',
      }),
    )

    await waitFor(() => expect(mockCollections).toHaveLength(0))
    // 合集没了，里面的对话回到任务区，不用展开任何合集就看得到。
    expect(await screen.findByRole('link', { name: '里面的对话' })).toBeVisible()
  })

  it('归属弹窗也能把跑完的对话记到需求单下', async () => {
    const task = addMockTask('儿童运动凉鞋多场景卖点')
    const conversation = addMockConversation('跑完才想起要挂单')
    const user = await openSidebar()
    await screen.findByText('跑完才想起要挂单')

    await user.click(screen.getByRole('button', { name: '跑完才想起要挂单 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '移到合集…' }))
    const dialog = await screen.findByRole('dialog', { name: '任务归属' })
    await user.selectOptions(await within(dialog).findByLabelText('需求单'), task.id)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation.taskId).toBe(task.id))
    expect(conversation.collectionId).toBeNull()
  })
})
