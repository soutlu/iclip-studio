import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toast, Toaster } from '@/shared/ui/toast'
import { loginAs, mockAuthUser, mockGovernor } from '@/testing/mocks/handlers'
import { resetMockHitCases } from '@/testing/mocks/hit-cases'
import { mockLibraryVideos } from '@/testing/mocks/library'
import { mockTagId } from '@/testing/mocks/library-tags'
import { resetMockReferences } from '@/testing/mocks/references'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { stubScrollViewport } from '@/testing/scroll-viewport'
import { DEFAULT_REFERENCE_SCOPE } from '../references.api'
import { ReferencesRoute } from './references-route'

function Harness() {
  const [scope, setScope] = useState(DEFAULT_REFERENCE_SCOPE)
  return (
    <>
      <ReferencesRoute
        myUserName="tester"
        onReferenceChange={() => {}}
        onScopeChange={setScope}
        referenceId={null}
        scope={scope}
        tabs={null}
      />
      <Toaster />
    </>
  )
}

/** 记下改标签树的请求（不含读树）。 */
const recordTagWrites = () => {
  const writes: { method: string; path: string; body: unknown }[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (request.method === 'GET' || !url.pathname.includes('/api/library-tags')) return
    void request
      .clone()
      .text()
      .then((text) =>
        writes.push({
          body: text === '' ? undefined : (JSON.parse(text) as unknown),
          method: request.method,
          path: url.pathname.replace('/api', ''),
        }),
      )
  })
  return writes
}

const openAdmin = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: '管理标签' }))
  return screen.findByRole('region', { name: '管理标签' })
}

const selectAction = async (
  user: ReturnType<typeof userEvent.setup>,
  tag: string,
  action: string,
) => {
  await user.click(screen.getByRole('button', { name: `管理${tag}` }))
  await user.click(await screen.findByRole('menuitem', { name: action }))
}

const dimensionNames = () =>
  within(screen.getByRole('region', { name: '管理标签' }))
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent)

const valueNames = (dimension: string) =>
  within(screen.getByRole('list', { name: `${dimension}的标签` }))
    .getAllByRole('button', { name: /^管理/ })
    .map((button) => button.getAttribute('aria-label')?.replace(/^管理/, ''))

beforeEach(() => {
  stubScrollViewport({ role: 'main', name: '资料库' }, { width: 1200, height: 900 })
  resetMockReferences([])
  resetMockHitCases([])
})

afterEach(() => {
  toast.dismiss()
})

describe('管理标签', () => {
  it('非治理者看不到入口', async () => {
    loginAs(mockAuthUser)
    await renderWithProviders(<Harness />)
    await screen.findByRole('button', { name: '内容结构：内容结构' })
    expect(screen.queryByRole('button', { name: '管理标签' })).toBeNull()
  })

  it('治理者打开后替换卡片列表，「完成」回到列表', async () => {
    loginAs(mockGovernor)
    resetMockReferences([{ tagIds: [mockTagId('AMZ')] }])
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article')
    const panel = await openAdmin(user)
    expect(screen.queryByRole('article')).toBeNull()
    expect(dimensionNames()).toEqual(['品牌', '平台&渠道', '品类', '场景', '内容结构'])
    await user.click(within(panel).getByRole('button', { name: '完成' }))
    expect(await screen.findByRole('article')).toBeVisible()
    expect(screen.queryByRole('region', { name: '管理标签' })).toBeNull()
  })

  it('直接添加下级后可连续录入同级，保留焦点并按录入顺序插入', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await user.click(screen.getByRole('button', { name: '给场景添加标签' }))
    await user.type(screen.getByRole('textbox', { name: '场景的标签名称' }), '海边度假{Enter}')
    await waitFor(() => expect(valueNames('场景')).toContain('海边度假'))
    const sceneName = screen.getByRole('textbox', { name: '场景的标签名称' })
    expect(sceneName).toHaveValue('')
    expect(sceneName).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '给海边度假添加下级' }))
    const childName = screen.getByRole('textbox', { name: '海边度假的小类名称' })
    expect(childName).toHaveFocus()
    await user.type(childName, '沙滩{Enter}')
    const children = await screen.findByRole('list', { name: '海边度假的小类' })
    expect(await within(children).findByText('沙滩')).toBeVisible()
    await waitFor(() => expect(childName).toHaveValue(''))
    expect(childName).toHaveFocus()
    await user.keyboard('海边步道{Enter}')
    expect(await within(children).findByText('海边步道')).toBeVisible()
    await waitFor(() => expect(childName).toHaveValue(''))
    expect(childName).toHaveFocus()
    expect(
      within(children)
        .getAllByRole('button', { name: /^管理/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['管理沙滩', '管理海边步道'])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '海边度假的小类名称' })).toBeNull()
    expect(children).toBeVisible()
    const added = writes.filter((write) => write.method === 'POST')
    expect(added[0]).toEqual({
      body: { name: '海边度假', parentId: mockTagId('场景'), position: 0 },
      method: 'POST',
      path: '/library-tags',
    })
    expect(added.slice(1).map((write) => write.body)).toEqual([
      { name: '沙滩', parentId: mockTagId('海边度假'), position: 0 },
      { name: '海边步道', parentId: mockTagId('海边度假'), position: 1 },
    ])
  })

  it('录入下级时点祖先不会收起分支或丢失草稿，结束后可正常折叠', async () => {
    loginAs(mockGovernor)
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    const parent = screen.getByRole('button', { name: '产品展示型' })
    expect(parent).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: '给360°全景展示添加下级' }))
    const input = screen.getByRole('textbox', { name: '360°全景展示的小类名称' })
    await user.type(input, '旋转鞋底特写')
    await user.click(parent)
    expect(parent).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveValue('旋转鞋底特写')
    expect(input).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '360°全景展示的小类名称' })).toBeNull()
    expect(parent).toHaveAttribute('aria-expanded', 'true')
    await user.click(parent)
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '给360°全景展示添加下级' })).toBeNull()
    await user.click(parent)
    expect(screen.getByRole('button', { name: '给360°全景展示添加下级' })).toBeVisible()
  })

  it('就地改名与同级排序：树重读后保持更新的顺序', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await selectAction(user, 'AMZ', '重命名')
    const input = screen.getByRole('textbox', { name: 'AMZ的新名称' })
    await user.clear(input)
    await user.type(input, 'Amazon{Enter}')
    await waitFor(() => expect(valueNames('平台&渠道')[0]).toBe('Amazon'))
    await selectAction(user, 'DTC', '同级上移')
    await waitFor(() => expect(valueNames('平台&渠道').slice(0, 2)).toEqual(['DTC', 'Amazon']))
    await user.click(screen.getByRole('button', { name: '管理DTC' }))
    expect(await screen.findByRole('menuitem', { name: '同级上移' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(writes).toEqual([
      { body: { name: 'Amazon' }, method: 'PATCH', path: `/library-tags/${mockTagId('Amazon')}` },
      { body: { position: 0 }, method: 'PATCH', path: `/library-tags/${mockTagId('DTC')}` },
    ])
  })

  it('维度可跨原列边界移动，返回后的筛选框顺序一致', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const panel = await openAdmin(user)
    await selectAction(user, '品类', '同级上移')
    await waitFor(() =>
      expect(dimensionNames()).toEqual(['品牌', '品类', '平台&渠道', '场景', '内容结构']),
    )
    await selectAction(user, '内容结构', '同级上移')
    await waitFor(() =>
      expect(dimensionNames()).toEqual(['品牌', '品类', '平台&渠道', '内容结构', '场景']),
    )
    expect(writes).toEqual([
      { body: { position: 1 }, method: 'PATCH', path: `/library-tags/${mockTagId('品类')}` },
      { body: { position: 3 }, method: 'PATCH', path: `/library-tags/${mockTagId('内容结构')}` },
    ])
    await user.click(within(panel).getByRole('button', { name: '完成' }))
    const filterNames = screen
      .getAllByRole('button', { name: /^(品类|平台&渠道|内容结构|场景)：/ })
      .map((button) => button.getAttribute('aria-label'))
    expect(filterNames).toEqual([
      '品类：品类',
      '平台&渠道：平台&渠道',
      '内容结构：内容结构',
      '场景：场景',
    ])
  })

  it('维度改名只改名称，不按业务名称重新分配位置', async () => {
    loginAs(mockGovernor)
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await selectAction(user, '内容结构', '重命名')
    const input = screen.getByRole('textbox', { name: '内容结构的新名称' })
    await user.clear(input)
    await user.type(input, '视频结构{Enter}')
    await waitFor(() =>
      expect(dimensionNames()).toEqual(['品牌', '平台&渠道', '品类', '场景', '视频结构']),
    )
  })

  it('新维度在顶部就地创建，保存后仍为全局第一项，默认人工填写', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await user.click(screen.getByRole('button', { name: '添加维度' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dimensionNames()[0]).toBe('新维度')
    const name = screen.getByRole('textbox', { name: '维度名称' })
    expect(name).toHaveFocus()
    await user.type(name, '服装系列{Enter}')
    await waitFor(() =>
      expect(dimensionNames()).toEqual([
        '服装系列',
        '品牌',
        '平台&渠道',
        '品类',
        '场景',
        '内容结构',
      ]),
    )
    expect(within(screen.getByRole('region', { name: '服装系列' })).getByText('人工')).toBeVisible()
    expect(writes).toEqual([
      {
        body: { name: '服装系列', parentId: null, position: 0 },
        method: 'POST',
        path: '/library-tags',
      },
    ])
  })

  it('新维度创建失败保留输入，Escape 取消并归还焦点', async () => {
    loginAs(mockGovernor)
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    const trigger = screen.getByRole('button', { name: '添加维度' })
    await user.click(trigger)
    const name = screen.getByRole('textbox', { name: '维度名称' })
    await user.type(name, '品牌{Enter}')
    expect(await screen.findByText('添加失败：已有名为「品牌」的维度')).toBeVisible()
    expect(name).toHaveValue('品牌')
    await user.click(name)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '维度名称' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('删除确认展示两库影响数量，取消不写入，确认后标签消失', async () => {
    loginAs(mockGovernor)
    resetMockReferences([
      { tagIds: [mockTagId('AMZ')] },
      { tagIds: [mockTagId('AMZ'), mockTagId('短靴')] },
    ])
    const [video] = mockLibraryVideos()
    if (video === undefined) throw new Error('成片素材 mock 为空')
    resetMockHitCases([{ jobId: video.face.jobId, tagIds: [mockTagId('AMZ')] }])
    const amz = mockTagId('AMZ')
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await selectAction(user, 'AMZ', '删除')
    const dialog = screen.getByRole('dialog', { name: '删除「AMZ」' })
    expect(dialog).toHaveTextContent('灵感库 2 条、爆款素材库 1 条')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(writes).toEqual([])
    await selectAction(user, 'AMZ', '删除')
    await user.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(valueNames('平台&渠道')).not.toContain('AMZ'))
    expect(writes).toEqual([{ body: undefined, method: 'DELETE', path: `/library-tags/${amz}` }])
  })

  it('维度设置在保存时一起提交判断说明与 AI 开关', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await selectAction(user, '场景', '维度设置')
    const dialog = screen.getByRole('dialog', { name: '维度设置' })
    const toggle = within(dialog).getByRole('switch', { name: 'AI 自动打标' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    await user.type(within(dialog).getByRole('textbox', { name: '判断说明' }), '按主要使用场景判断')
    expect(writes).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes).toEqual([
      {
        body: { autoFill: null, guide: '按主要使用场景判断', name: '场景' },
        method: 'PATCH',
        path: `/library-tags/${mockTagId('场景')}`,
      },
    ])
  })

  it.each(['添加', '重命名'] as const)('%s 失败时保留输入和原有标签', async (action) => {
    loginAs(mockGovernor)
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    if (action === '添加')
      await user.click(screen.getByRole('button', { name: '给平台&渠道添加标签' }))
    else await selectAction(user, 'DTC', '重命名')
    const input = screen.getByRole('textbox', {
      name: action === '添加' ? '平台&渠道的标签名称' : 'DTC的新名称',
    })
    await user.clear(input)
    await user.type(input, 'AMZ{Enter}')
    expect(
      await screen.findByText(
        `${action === '添加' ? '添加' : '保存'}失败：「平台&渠道」中已有「AMZ」`,
      ),
    ).toBeVisible()
    expect(input).toHaveValue('AMZ')
    expect(screen.getByRole('list', { name: '平台&渠道的标签' })).toHaveTextContent('AMZ')
  })

  it('删除失败时保留确认框和标签，可重试', async () => {
    loginAs(mockGovernor)
    server.use(
      http.delete('/api/library-tags/:tagId', () =>
        HttpResponse.json({ detail: '标签暂时无法删除' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await selectAction(user, 'AMZ', '删除')
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('删除失败：标签暂时无法删除')).toBeVisible()
    expect(screen.getByRole('dialog', { name: '删除「AMZ」' })).toBeVisible()
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(valueNames('平台&渠道')).toContain('AMZ')
  })
})
