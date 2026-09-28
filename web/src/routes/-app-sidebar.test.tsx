import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
import { LoginPromptProvider } from './-login-prompt'

/** 测试壳持有折叠状态，与应用壳的状态归属一致。 */
function SidebarHarness({ compact = false }: { compact?: boolean }) {
  const [collapsed, setCollapsed] = useState(true)
  return <AppSidebar collapsed={collapsed} compact={compact} onCollapsedChange={setCollapsed} />
}

const renderSidebar = (requireLogin = vi.fn(), initialPath = '/', compact = false) =>
  renderWithProviders(
    <LoginPromptProvider value={requireLogin}>
      <SidebarHarness compact={compact} />
    </LoginPromptProvider>,
    { initialPath },
  )

describe('AppSidebar', () => {
  it('桌面折叠时保留导航图标与账户入口，点开后显示完整侧栏', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    expect(screen.getByRole('complementary')).toBeVisible()

    for (const name of ['新建任务', '搜索', '需求单', '资料库', '登录']) {
      expect(screen.getByRole('button', { name })).toBeVisible()
    }
    expect(await screen.findByText('登录后查看对话')).not.toBeVisible()

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

  it.each([false, true])('路由切换仅收起移动抽屉，搜索保留导航，compact=%s', async (compact) => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const { router } = await renderSidebar(vi.fn(), '/', compact)
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })

    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByRole('dialog', { name: '搜索对话' })).toBeVisible()
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

    expect(screen.getByText('登录后查看对话')).toBeVisible()
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

    expect(await screen.findByRole('dialog', { name: '搜索对话' })).toBeVisible()
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
      const dialog = await screen.findByRole('dialog', { name: '搜索对话' })
      expect(screen.getByRole('button', { name: '展开侧边栏', hidden: true })).toBeInTheDocument()
      await user.type(within(dialog).getByRole('textbox', { name: '搜索对话' }), '广告')
      const result = await within(dialog).findByRole('link', { name: conversation.title })

      if (modifier === 'Meta') {
        await user.click(result)
      } else {
        await user.tab()
        expect(result).toHaveFocus()
        await user.keyboard('{Enter}')
      }

      await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${conversation.id}`))
      expect(screen.queryByRole('dialog', { name: '搜索对话' })).not.toBeInTheDocument()
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
    '折叠状态为 %s 时按权限禁用入口，快捷键也不打开搜索或离开当前页',
    async (collapsed) => {
      loginAs(mockAuthUser, { permissions: ['tasks:read'] })
      const user = userEvent.setup()
      const { router } = await renderSidebar(vi.fn(), '/tasks')
      if (!collapsed) await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
      await screen.findByRole('button', { name: '用户菜单' })

      expect(screen.getByRole('button', { name: '搜索' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '新建任务' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '需求单' })).toBeEnabled()
      expect(screen.getByRole('button', { name: '资料库' })).toBeDisabled()
      if (!collapsed) expect(screen.getByText('当前账号没有查看对话权限')).toBeVisible()
      await user.keyboard('{Control>}k{/Control}')
      await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}')

      expect(screen.queryByRole('dialog', { name: '搜索对话' })).not.toBeInTheDocument()
      expect(router.state.location.pathname).toBe('/tasks')
    },
  )

  it('能看出片记录的账号点资料库去 /library', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const { router } = await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })

    await user.click(screen.getByRole('button', { name: '资料库' }))

    expect(router.state.location.pathname).toBe('/library')
  })

  it('只有带 users:manage 的账号看得到「治理」组的「全部对话」「审计」入口，分别去 /conversations 与 /audit', async () => {
    loginAs(mockAuthUser)
    const user = userEvent.setup()
    const plain = await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    expect(screen.queryByRole('group', { name: '治理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部对话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '审计' })).not.toBeInTheDocument()
    plain.unmount()

    loginAs(mockAuthUser, { permissions: [...mockAuthUser.permissions, 'users:manage'] })
    const { router } = await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    const govern = screen.getByRole('group', { name: '治理' })
    expect(within(govern).getByRole('button', { name: '全部对话' })).toBeVisible()
    expect(within(govern).getByRole('button', { name: '审计' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeVisible()
    await user.click(await screen.findByRole('button', { name: '全部对话' }))
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

    expect(await screen.findByRole('button', { name: '任务' })).toBeVisible()
    expect(
      screen.getAllByRole('button', { name: /^(合集|任务)$/ }).map((one) => one.textContent),
    ).toEqual(['合集', '任务'])
    expect(screen.getByText('没归类的那段')).toBeVisible()
    expect(screen.queryByText('合集里的那段')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '夏季亚麻系列 (1)' }))

    expect(screen.getByText('合集里的那段')).toBeVisible()
  })

  it.each([false, true])('收起再展开保留合集展开与对话节点，compact=%s', async (compact) => {
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

  it('新建合集后出现在合集区', async () => {
    const user = await openSidebar()
    await screen.findByText('还没有合集')

    await user.click(screen.getByRole('button', { name: '新建合集' }))
    await user.type(await screen.findByLabelText('合集名称'), '春季童鞋')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('button', { name: '春季童鞋 (0)' })).toBeVisible()
  })

  it('合集行菜单可以改名，也可以删掉——删掉不带走里面的对话', async () => {
    const collection = addMockCollection('待改名')
    addMockConversation('里面的对话').collectionId = collection.id
    const user = await openSidebar()
    await screen.findByRole('button', { name: '待改名 (1)' })

    await user.click(screen.getByRole('button', { name: '待改名 的操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByLabelText('合集名称')
    await user.clear(input)
    await user.type(input, '改好了')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('button', { name: '改好了 (1)' })).toBeVisible()

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
    await user.click(await screen.findByRole('menuitem', { name: '归属' }))
    const dialog = await screen.findByRole('dialog', { name: '对话归属' })
    await user.selectOptions(await within(dialog).findByLabelText('需求单'), task.id)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation.taskId).toBe(task.id))
    expect(conversation.collectionId).toBeNull()
  })
})
