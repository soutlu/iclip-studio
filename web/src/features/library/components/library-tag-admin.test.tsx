import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const pickDimension = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: /^切换维度/ }))
  await user.click(await screen.findByRole('menuitemradio', { name }))
  await screen.findByRole('heading', { name })
}

const valueNames = (dimension: string) =>
  within(screen.getByRole('list', { name: `${dimension}的取值` }))
    .getAllByRole('listitem')
    .map((item) => item.firstElementChild?.firstElementChild?.textContent)

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

  it('治理者打开后面板替换卡片列表，「完成」回到列表', async () => {
    loginAs(mockGovernor)
    resetMockReferences([{ tagIds: [mockTagId('AMZ')] }])
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article')

    const panel = await openAdmin(user)

    expect(screen.getByRole('button', { name: '管理标签' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('article')).toBeNull()
    expect(within(panel).getByRole('heading', { name: '品牌' })).toBeVisible()
    await user.click(within(panel).getByRole('button', { name: '完成' }))
    expect(await screen.findByRole('article')).toBeVisible()
    expect(screen.queryByRole('region', { name: '管理标签' })).toBeNull()
  })

  it('添加取值与小类：发出带上级的请求，树重读后新的一行出现', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await pickDimension(user, '场景')

    await user.type(screen.getByRole('textbox', { name: '取值名称' }), '海边度假')
    await user.click(screen.getByRole('button', { name: '添加取值' }))

    await waitFor(() => expect(valueNames('场景')).toContain('海边度假'))
    expect(screen.getByRole('textbox', { name: '取值名称' })).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '给海边度假添加小类' }))
    await user.type(screen.getByRole('textbox', { name: '海边度假的小类名称' }), '沙滩{Enter}')
    expect(
      await within(screen.getByRole('list', { name: '海边度假的小类' })).findByText('沙滩'),
    ).toBeVisible()

    const added = writes.filter((write) => write.method === 'POST')
    expect(added[0]).toEqual({
      body: { name: '海边度假', parentId: mockTagId('场景') },
      method: 'POST',
      path: '/library-tags',
    })
    expect(added[1]?.body).toEqual({ name: '沙滩', parentId: mockTagId('海边度假') })
  })

  it('就地改名与上移：发出 PATCH，列表跟着树重读', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await pickDimension(user, '平台&渠道')

    await user.click(screen.getByRole('button', { name: '重命名AMZ' }))
    const input = screen.getByRole('textbox', { name: 'AMZ的新名称' })
    await user.clear(input)
    await user.type(input, 'Amazon{Enter}')
    await waitFor(() => expect(valueNames('平台&渠道')[0]).toBe('Amazon'))

    await user.click(screen.getByRole('button', { name: '上移DTC' }))
    await waitFor(() => expect(valueNames('平台&渠道').slice(0, 2)).toEqual(['DTC', 'Amazon']))
    expect(screen.getByRole('button', { name: '上移DTC' })).toHaveAttribute('aria-disabled', 'true')

    const amz = mockTagId('Amazon')
    const dtc = mockTagId('DTC')
    expect(writes).toEqual([
      { body: { name: 'Amazon' }, method: 'PATCH', path: `/library-tags/${amz}` },
      { body: { position: 0 }, method: 'PATCH', path: `/library-tags/${dtc}` },
    ])
  })

  it('删除前确认写出两库各有几条，确认后发出 DELETE、那一行消失', async () => {
    loginAs(mockGovernor)
    resetMockReferences([
      { tagIds: [mockTagId('AMZ')] },
      { tagIds: [mockTagId('AMZ'), mockTagId('短靴')] },
      { tagIds: [mockTagId('DTC')] },
    ])
    const [video] = mockLibraryVideos()
    if (video === undefined) throw new Error('成片素材 mock 为空')
    resetMockHitCases([{ jobId: video.face.jobId, tagIds: [mockTagId('AMZ')] }])
    const amz = mockTagId('AMZ')
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await pickDimension(user, '平台&渠道')

    await user.click(screen.getByRole('button', { name: '删除AMZ' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      '删除后，灵感库 2 条、爆款 1 条会去掉该标签',
    )
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(writes).toEqual([])

    await user.click(screen.getByRole('button', { name: '删除AMZ' }))
    await user.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => expect(valueNames('平台&渠道')).not.toContain('AMZ'))
    expect(writes).toEqual([{ body: undefined, method: 'DELETE', path: `/library-tags/${amz}` }])
  })

  it('「AI 打标」开关改维度的 autoFill', async () => {
    loginAs(mockGovernor)
    const writes = recordTagWrites()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await pickDimension(user, '平台&渠道')

    const toggle = screen.getByRole('switch', { name: 'AI 打标' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(writes).toEqual([
      {
        body: { autoFill: 'ai' },
        method: 'PATCH',
        path: `/library-tags/${mockTagId('平台&渠道')}`,
      },
    ])
  })

  it('服务端不收（422）时提示它给的原因，输入框保留', async () => {
    loginAs(mockGovernor)
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await openAdmin(user)
    await pickDimension(user, '平台&渠道')

    const input = screen.getByRole('textbox', { name: '取值名称' })
    await user.type(input, 'AMZ')
    await user.click(screen.getByRole('button', { name: '添加取值' }))

    expect(await screen.findByText('添加失败：「平台&渠道」中已有「AMZ」')).toBeVisible()
    expect(input).toHaveValue('AMZ')
  })
})
