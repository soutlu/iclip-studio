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
    const listed = () =>
      screen
        .getAllByRole('button', { name: /的角色：/ })
        .map((button) => button.getAttribute('aria-label')?.replace(/的角色：.*$/, ''))

    for (const [keyword, names] of [
      ['治理', ['治理者']],
      [chen.username, ['陈晓']],
      ['TESTER@EXAMPLE', ['测试用户']],
      ['内容中心', ['小王']],
    ] as const) {
      await user.clear(search)
      await user.type(search, keyword)
      expect(listed()).toEqual(names)
    }

    await user.clear(search)
    await user.type(search, '没有这个人')
    expect(screen.getByText('没有匹配的用户')).toBeVisible()
    expect(screen.queryByRole('list', { name: '用户列表' })).not.toBeInTheDocument()
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
