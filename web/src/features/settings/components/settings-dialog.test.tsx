import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { addMockUser, loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SettingsDialog } from './settings-dialog'

type Sent = { body: unknown; method: string; path: string }

const content = {
  id: 1,
  leaderUserId: null,
  leaderUserUid: '',
  name: '内容中心',
  order: null,
  parentId: null,
  parentUid: '',
  source: 'feishu',
  type: 'department',
  uid: 'od-content',
}

/** 发往 `/api/users/<id>…` 的写请求，按先后。 */
const recordWrites = () => {
  const sent: Sent[] = []
  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' || !pathname.startsWith('/api/users/')) return
    void request
      .clone()
      .json()
      .then((body: unknown) => sent.push({ body, method: request.method, path: pathname }))
  })
  return sent
}

const renderSettings = async () => {
  const wang = addMockUser('小王', undefined, {
    departments: [content],
    modelGroup: 'mkt',
    roles: ['viewer', 'admin'],
  })
  const chen = addMockUser('陈晓')
  loginAs(mockGovernor)
  const user = userEvent.setup()
  await renderWithProviders(
    <>
      <Toaster />
      <SettingsDialog onOpenChange={() => {}} open />
    </>,
  )
  await screen.findByRole('list', { name: '用户列表' })
  return { chen, user, wang }
}

const rowOf = (name: string) => {
  const row = screen
    .getAllByRole('listitem')
    .find((item) => within(item).queryByText(name, { exact: true }) !== null)
  if (row === undefined) throw new Error(`没有 ${name} 这一行`)
  return within(row)
}

/** 列表里按先后列出的名字（取自每行角色按钮的无障碍名称）。 */
const listedNames = () =>
  screen
    .getAllByRole('button', { name: /的角色：/ })
    .map((button) => button.getAttribute('aria-label')?.replace(/的角色：.*$/, ''))

afterEach(() => {
  toast.dismiss()
})

describe('SettingsDialog 用户', () => {
  it('每行显示部门和邮箱、最高的那个角色、当前配置组', async () => {
    const { wang } = await renderSettings()

    const row = rowOf('小王')
    expect(row.getByText(`内容中心 · ${wang.email}`)).toBeVisible()
    expect(row.getByRole('button', { name: '小王的角色：管理员' })).toBeVisible()
    expect(row.getByRole('button', { name: '小王的配置组：mkt' })).toBeVisible()
    expect(rowOf('陈晓').getByRole('button', { name: '陈晓的角色：编辑' })).toBeVisible()
    expect(rowOf('陈晓').getByRole('button', { name: '陈晓的配置组：默认组' })).toBeVisible()
  })

  it('选组发出 PUT，选「默认组」传 null，这一行跟着变', async () => {
    const { chen, user, wang } = await renderSettings()
    const sent = recordWrites()

    await user.click(rowOf('陈晓').getByRole('button', { name: '陈晓的配置组：默认组' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'ecom' }))
    expect(await rowOf('陈晓').findByRole('button', { name: '陈晓的配置组：ecom' })).toBeVisible()

    await user.click(rowOf('小王').getByRole('button', { name: '小王的配置组：mkt' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '默认组' }))
    expect(await rowOf('小王').findByRole('button', { name: '小王的配置组：默认组' })).toBeVisible()

    expect(sent).toEqual([
      { body: { modelGroup: 'ecom' }, method: 'PUT', path: `/api/users/${chen.id}/model-group` },
      { body: { modelGroup: null }, method: 'PUT', path: `/api/users/${wang.id}/model-group` },
    ])
  })

  it('改角色发出 PATCH，roles 只含选中的那一个', async () => {
    const { user, wang } = await renderSettings()
    const sent = recordWrites()

    await user.click(rowOf('小王').getByRole('button', { name: '小王的角色：管理员' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'root' }))

    expect(await rowOf('小王').findByRole('button', { name: '小王的角色：root' })).toBeVisible()
    expect(sent).toEqual([
      { body: { roles: ['root'] }, method: 'PATCH', path: `/api/users/${wang.id}` },
    ])
  })

  it('自己那行的角色不能改，悬停说明原因', async () => {
    const { user } = await renderSettings()

    const own = rowOf('治理者').getByRole('button', { name: '治理者的角色：root' })
    expect(own).toHaveAttribute('aria-disabled', 'true')
    await user.hover(own)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('无法修改自己的角色')
    await user.click(own)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(rowOf('治理者').getByRole('button', { name: '治理者的配置组：默认组' })).toBeEnabled()
  })

  it('按显示名、用户名、邮箱、部门搜索，没有匹配时说明', async () => {
    const { chen, user } = await renderSettings()
    const search = screen.getByRole('searchbox', { name: '搜索用户' })

    for (const [keyword, names] of [
      ['治理', ['治理者']],
      [chen.username, ['陈晓']],
      ['TESTER@EXAMPLE', ['测试用户']],
      ['内容中心', ['小王']],
    ] as const) {
      await user.clear(search)
      await user.type(search, keyword)
      expect(listedNames()).toEqual(names)
    }

    await user.clear(search)
    await user.type(search, '没有这个人')
    expect(screen.getByText('暂无匹配的成员')).toBeVisible()
    expect(screen.queryByRole('list', { name: '用户列表' })).not.toBeInTheDocument()
  })

  it('按最高角色筛选，和搜索同时生效，点「全部」恢复', async () => {
    const { user } = await renderSettings()
    const search = screen.getByRole('searchbox', { name: '搜索用户' })
    const filters = screen.getByRole('tablist', { name: '按角色筛选' })

    await user.click(within(filters).getByRole('tab', { name: '管理员' }))
    expect(listedNames()).toEqual(['小王'])

    await user.click(within(filters).getByRole('tab', { name: '编辑' }))
    expect(listedNames()).toEqual(['测试用户', '陈晓'])
    await user.type(search, 'TESTER@')
    expect(listedNames()).toEqual(['测试用户'])

    await user.clear(search)
    await user.click(within(filters).getByRole('tab', { name: '全部' }))
    expect(listedNames()).toEqual(['测试用户', '治理者', '小王', '陈晓'])
  })

  it('没有匹配时点「清除筛选条件」，搜索词和角色筛选一起清掉', async () => {
    const { user } = await renderSettings()
    const search = screen.getByRole('searchbox', { name: '搜索用户' })

    await user.click(screen.getByRole('tab', { name: '只读' }))
    await user.type(search, '陈晓')
    expect(screen.getByText('暂无匹配的成员')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '清除筛选条件' }))
    expect(search).toHaveValue('')
    expect(screen.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'true')
    expect(listedNames()).toEqual(['测试用户', '治理者', '小王', '陈晓'])
  })

  it('存的配置组已失效：按钮写明失效，菜单只列现有的组并说明，选「默认组」把他挪走', async () => {
    const zhou = addMockUser('周明远', undefined, { modelGroup: 'legacy-vip' })
    const { user } = await renderSettings()
    const sent = recordWrites()

    await user.click(
      rowOf('周明远').getByRole('button', { name: '周明远的配置组：legacy-vip（已失效）' }),
    )
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['默认组', 'mkt', 'ecom'])
    expect(within(menu).queryByRole('menuitemradio', { checked: true })).not.toBeInTheDocument()
    expect(within(menu).getByText('原配置组「legacy-vip」已失效；请切换')).toBeVisible()

    await user.click(within(menu).getByRole('menuitemradio', { name: '默认组' }))
    expect(
      await rowOf('周明远').findByRole('button', { name: '周明远的配置组：默认组' }),
    ).toBeVisible()
    expect(sent).toEqual([
      { body: { modelGroup: null }, method: 'PUT', path: `/api/users/${zhou.id}/model-group` },
    ])
  })

  it('底栏写人数和配置组数，筛选后写显示了几位', async () => {
    const { user } = await renderSettings()

    expect(screen.getByText('共 4 位成员 · 2 个配置组')).toBeVisible()
    await user.type(screen.getByRole('searchbox', { name: '搜索用户' }), '陈晓')
    expect(screen.getByText('显示 1 / 4 位成员 · 2 个配置组')).toBeVisible()
  })

  it('没有任何配置组时配置组不能改，悬停说明原因，底栏不写配置组数', async () => {
    server.use(http.get('*/api/model-providers/groups', () => HttpResponse.json({ groups: [] })))
    const { user } = await renderSettings()

    const group = rowOf('陈晓').getByRole('button', { name: '陈晓的配置组：默认组' })
    expect(group).toHaveAttribute('aria-disabled', 'true')
    await user.hover(group)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('当前未配置其他配置组')
    expect(screen.getByText('共 4 位成员')).toBeVisible()
  })

  it('自己那行带「我」；名字就是邮箱的账号第二行不再重复邮箱', async () => {
    addMockUser('mailbox@example.com', undefined, { email: 'mailbox@example.com' })
    await renderSettings()

    expect(rowOf('治理者').getByText('我')).toBeVisible()
    expect(rowOf('小王').queryByText('我')).not.toBeInTheDocument()
    expect(rowOf('mailbox@example.com').getAllByText(/mailbox@example\.com/)).toHaveLength(1)
  })

  it('保存失败时这一行回到原值，并提示后端给的原因', async () => {
    const { user } = await renderSettings()
    server.use(
      http.put('*/api/users/:id/model-group', () =>
        HttpResponse.json({ detail: '配置组 ecom 不在部署配置里' }, { status: 422 }),
      ),
    )

    await user.click(rowOf('陈晓').getByRole('button', { name: '陈晓的配置组：默认组' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'ecom' }))

    expect(await screen.findByText('配置组保存失败：配置组 ecom 不在部署配置里')).toBeVisible()
    await waitFor(() =>
      expect(rowOf('陈晓').getByRole('button', { name: '陈晓的配置组：默认组' })).toBeEnabled(),
    )
  })
})
