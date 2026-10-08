import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, Toaster } from '@/shared/ui/toast'
import { pasteFilesIntoComposer } from '@/testing/editor'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { addMockReference, resetMockReferences } from '@/testing/mocks/references'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_REFERENCE_SCOPE, type ReferenceScope } from '../references.api'
import { ReferencesRoute } from './references-route'

/** 测试壳持有筛选范围与打开着的详情，与路由把两者存在查询参数里的归属一致：改筛选时详情随之关掉。 */
function Harness({
  onScope,
  onReference,
  initialReference = null,
}: {
  onScope?: (scope: ReferenceScope) => void
  onReference?: (id: string | null) => void
  initialReference?: string | null
}) {
  const [scope, setScope] = useState(DEFAULT_REFERENCE_SCOPE)
  const [referenceId, setReferenceId] = useState(initialReference)
  return (
    <>
      <ReferencesRoute
        myUserName="tester"
        onReferenceChange={(id) => {
          onReference?.(id)
          setReferenceId(id)
        }}
        onScopeChange={(next) => {
          onScope?.(next)
          setScope(next)
          setReferenceId(null)
        }}
        referenceId={referenceId}
        scope={scope}
        tabs={null}
      />
      <Toaster />
    </>
  )
}

/** 记下每次列表请求的查询串。 */
const recordListQueries = () => {
  const queries: URLSearchParams[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/api/references')) queries.push(url.searchParams)
  })
  return queries
}

/** 记下发给参考视频的写请求：方法、路径与请求体。 */
const recordWrites = () => {
  const writes: { method: string; path: string; body: unknown }[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (request.method === 'GET' || !url.pathname.includes('/api/references')) return
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

const cardNames = () =>
  screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))

const video = (name = '参考.mp4', bytes = 'mp4-bytes') =>
  new File([bytes], name, { type: 'video/mp4' })

const fileInput = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('页面上没有选文件的输入框')
  return input
}

const MINE_TAGGED = {
  categories: ['短靴', '卫衣'] as const,
  createdAt: '2026-09-23T11:00:00Z',
  id: '5ef00000-0000-4000-8000-0000000000a1',
  videoTypes: ['try_on'] as const,
}

/** jsdom 没有排版，元素尺寸都是 0；给页面滚动容器一个视口大小，虚拟列表才会渲染视口里的卡片。 */
const stubScrollViewport = () => {
  const sizeOf = (element: HTMLElement, size: number) => (element.tagName === 'MAIN' ? size : 0)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizeOf(this, 900)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizeOf(this, 1200)
  })
}

beforeEach(() => {
  stubScrollViewport()
  resetMockReferences([])
})

afterEach(() => {
  toast.dismiss()
  vi.unstubAllGlobals()
})

describe('参考视频列表', () => {
  it('卡片：状态角标、标签行（没有标签是「未标注」，没拆完说拆完自动打）、属主；底部计数', async () => {
    resetMockReferences([
      {
        ...MINE_TAGGED,
        categories: [...MINE_TAGGED.categories],
        videoTypes: [...MINE_TAGGED.videoTypes],
      },
      { breakdownStatus: 'running', createdAt: '2026-09-23T11:30:00Z', document: null },
      { breakdownStatus: 'pending', createdAt: '2026-09-23T11:40:00Z', document: null },
      {
        breakdownStatus: 'failed',
        createdAt: '2026-09-23T10:00:00Z',
        document: null,
        errorCode: 'video_unreadable',
      },
      { createdAt: '2026-09-23T09:00:00Z', userName: 'Maya.Cheng' },
    ])
    await renderWithProviders(<Harness />)

    const tagged = await screen.findByRole('article', { name: '上身展示 · 短靴 · 卫衣' })
    expect(within(tagged).getByRole('button', { name: /tester/ })).toBeVisible()
    const [pending, running] = screen.getAllByRole('article')
    expect(within(pending as HTMLElement).getByText('排队中')).toBeVisible()
    expect(within(running as HTMLElement).getByText('拆解中')).toBeVisible()
    expect(within(pending as HTMLElement).getByText('拆解完成后自动打标签')).toBeVisible()
    expect(screen.getByText('拆解失败')).toBeVisible()
    expect(screen.getAllByRole('article', { name: '未标注' })).toHaveLength(2)
    expect(screen.getByText('共 5 条')).toBeVisible()
  })

  it('canUpload 为假：没有上传按钮、选文件入口，空列表也不是拖放区', async () => {
    server.use(
      http.get('*/api/references', () =>
        HttpResponse.json({ canUpload: false, items: [], nextCursor: null, total: 0 }),
      ),
    )
    await renderWithProviders(<Harness />)

    expect(await screen.findByText('暂无参考视频')).toBeVisible()
    expect(screen.queryByRole('button', { name: '上传视频' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '选择文件' })).not.toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('一条都没有时整块列表区是拖放区，能选文件', async () => {
    await renderWithProviders(<Harness />)

    expect(await screen.findByText('将视频拖到此处或在本页粘贴，可直接上传')).toBeVisible()
    expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()
  })

  it('片子类型多选：名称与说明取自后端，勾一项重查一次、弹层留着，两项命中任一；「全部」清掉', async () => {
    resetMockReferences([
      {
        ...MINE_TAGGED,
        categories: [...MINE_TAGGED.categories],
        videoTypes: [...MINE_TAGGED.videoTypes],
      },
      { categories: ['拖鞋'], createdAt: '2026-09-23T10:00:00Z', videoTypes: ['lifestyle'] },
      { categories: ['拖鞋'], createdAt: '2026-09-23T09:00:00Z', videoTypes: ['review'] },
    ])
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('button', { name: '片子类型：片子类型' }))
    const popup = await screen.findByRole('dialog', { name: '选择片子类型' })
    expect(within(popup).getAllByRole('checkbox')).toHaveLength(8)
    expect(within(popup).getByText('模特穿上或戴上产品，展示上身效果')).toBeVisible()

    await user.click(within(popup).getByRole('checkbox', { name: /上身展示/ }))
    await user.click(within(popup).getByRole('checkbox', { name: /场景种草/ }))
    await waitFor(() => expect(cardNames()).toEqual(['上身展示 · 短靴 · 卫衣', '场景种草 · 拖鞋']))
    expect(queries.at(-1)?.getAll('videoTypes')).toEqual(['try_on', 'lifestyle'])
    expect(screen.getByText('找到 2 条')).toBeVisible()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('radio', { name: '全部' }))
    await waitFor(() => expect(cardNames()).toHaveLength(3))
    expect(queries.at(-1)?.has('videoTypes')).toBe(false)
  })

  it('品类平铺可搜多选：只列用到的，带条数', async () => {
    resetMockReferences([
      { categories: ['拖鞋', '卫衣'], createdAt: '2026-09-23T11:00:00Z' },
      { categories: ['拖鞋'], createdAt: '2026-09-23T10:00:00Z' },
      { categories: ['短靴'], createdAt: '2026-09-23T09:00:00Z' },
    ])
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('button', { name: '品类：品类' }))
    const popup = await screen.findByRole('dialog', { name: '选择品类' })
    expect(
      within(popup)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['拖鞋2', '短靴1', '卫衣1'])

    await user.type(within(popup).getByRole('combobox', { name: '搜索品类' }), '短')
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(queries.at(-1)?.getAll('categories')).toEqual(['短靴']))
    expect(await screen.findByText('找到 1 条')).toBeVisible()
  })

  it('按人筛：点卡片上的属主；候选取自后端的属主名单，还没翻到的属主也能选', async () => {
    // 第一页 24 条都是 Maya 的，tester 那条排在第二页。
    resetMockReferences([
      ...Array.from({ length: 24 }, (_, index) => ({
        createdAt: new Date(Date.UTC(2026, 8, 23, 11, index)).toISOString(),
        userName: 'Maya.Cheng',
      })),
      { createdAt: '2026-09-22T10:00:00Z', userName: 'tester' },
    ])
    // 页脚不进视口，不自动翻到第二页。
    stubIntersectionObserver()
    const queries = recordListQueries()
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('button', { name: '人：人' }))
    const popup = await screen.findByRole('dialog', { name: '选择人' })
    expect(
      within(popup)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['MMaya.Cheng', 'Ttester'])
    await user.click(within(popup).getByRole('option', { name: /tester/ }))
    await waitFor(() => expect(queries.at(-1)?.get('userName')).toBe('tester'))
    expect(await screen.findByText('找到 1 条')).toBeVisible()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    expect(await screen.findByText('共 25 条')).toBeVisible()
    const [maya] = screen.getAllByRole('article')
    await user.click(within(maya as HTMLElement).getByRole('button', { name: /Maya\.Cheng/ }))
    expect(onScope).toHaveBeenLastCalledWith(expect.objectContaining({ userName: 'Maya.Cheng' }))
  })

  it('还有没拆完的行就轮询，拆完后自动换上标签', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const row = addMockReference({ breakdownStatus: 'running', document: null })
      await renderWithProviders(<Harness />)
      expect(await screen.findByText('拆解中')).toBeVisible()

      resetMockReferences([{ ...row, breakdownStatus: 'completed', categories: ['拖鞋'] }])
      await vi.advanceTimersByTimeAsync(5000)

      expect(await screen.findByRole('article', { name: '拖鞋' })).toBeVisible()
      expect(screen.queryByText('拆解中')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('上传参考视频', () => {
  it('按钮选文件：每个视频一张卡，先上传再建行；不是视频的给一句提示、其余照传', async () => {
    const writes = recordWrites()
    const user = userEvent.setup({ applyAccept: false })
    await renderWithProviders(<Harness />)
    await screen.findByText('将视频拖到此处或在本页粘贴，可直接上传')

    await user.upload(fileInput(), [
      video('第一条.mp4', 'one'),
      new File(['png'], '截图.png', { type: 'image/png' }),
      video('第二条.mov', 'two'),
    ])

    expect(await screen.findByText('仅支持 MP4 或 MOV 视频，其他文件无法上传')).toBeVisible()
    await waitFor(() =>
      expect(screen.getAllByRole('article', { name: '拆解完成后自动打标签' })).toHaveLength(2),
    )
    const created = writes.filter((write) => write.path === '/references')
    expect(created).toHaveLength(2)
    expect(
      created.every((write) => typeof (write.body as { uploadId?: unknown }).uploadId === 'string'),
    ).toBe(true)
  })

  it('传了已经在资料库里的视频（200）：不新添卡片，提示一句并打开原来那一条', async () => {
    const existing = addMockReference({
      ...MINE_TAGGED,
      categories: [...MINE_TAGGED.categories],
      videoTypes: [...MINE_TAGGED.videoTypes],
    })
    server.use(http.post('*/api/references', () => HttpResponse.json(existing, { status: 200 })))
    const onReference = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onReference={onReference} />)
    await screen.findByRole('article', { name: '上身展示 · 短靴 · 卫衣' })

    await user.upload(fileInput(), video('同一条.mp4'))

    expect(await screen.findByText('该视频已在资料库中，已为你打开')).toBeVisible()
    expect(onReference).toHaveBeenLastCalledWith(existing.id)
    expect(await screen.findByRole('dialog', { name: '上身展示 · 短靴 · 卫衣' })).toBeVisible()
  })

  it('页面上粘贴视频文件就上传；焦点在输入框里、剪贴板里只有文字时不接', async () => {
    const writes = recordWrites()
    await renderWithProviders(<Harness />)
    await screen.findByText('将视频拖到此处或在本页粘贴，可直接上传')

    pasteFilesIntoComposer(screen.getByRole('textbox', { name: '搜索拆解' }), [video()])
    pasteFilesIntoComposer(document.body, [])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes).toEqual([])

    pasteFilesIntoComposer(document.body, [video()])
    await waitFor(() => expect(writes.some((write) => write.path === '/references')).toBe(true))
    expect(await screen.findByRole('article', { name: '拆解完成后自动打标签' })).toBeVisible()
  })

  it('整页拖放：亮出提示；带文件夹时提示一句，其余视频照传', async () => {
    const writes = recordWrites()
    await renderWithProviders(<Harness />)
    await screen.findByText('将视频拖到此处或在本页粘贴，可直接上传')
    const main = screen.getByRole('main', { name: '资料库' })
    const dataTransfer = {
      files: [video('拖进来的.mp4'), new File([], '素材夹')],
      items: [
        { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
      types: ['Files'],
    }

    fireEvent.dragEnter(main, { dataTransfer })
    expect(screen.getByText('松开鼠标上传视频')).toBeInTheDocument()
    fireEvent.drop(main, { dataTransfer })

    expect(screen.queryByText('松开鼠标上传视频')).not.toBeInTheDocument()
    expect(await screen.findByText('仅支持 MP4 或 MOV 视频，其他文件无法上传')).toBeVisible()
    await waitFor(() =>
      expect(writes.filter((write) => write.path === '/references')).toHaveLength(1),
    )
  })
})

describe('参考视频详情', () => {
  /** 打开一条：先放好这一行，再以它为详情渲染，等拆解正文出来。 */
  const openDetail = async (
    overrides: Parameters<typeof addMockReference>[0] = {},
    onReference?: (id: string | null) => void,
  ) => {
    const row = addMockReference({
      ...MINE_TAGGED,
      categories: [...MINE_TAGGED.categories],
      document: '# 出场元素\n\n第一版拆解',
      videoTypes: [...MINE_TAGGED.videoTypes],
      ...overrides,
    })
    await renderWithProviders(
      <Harness initialReference={row.id} {...(onReference ? { onReference } : {})} />,
    )
    const dialog = await screen.findByRole('dialog')
    return { dialog, row }
  }

  it('属主：标签小块能去掉，「+」从清单里加；改动整份带 version 提交', async () => {
    const writes = recordWrites()
    const user = userEvent.setup()
    const { dialog, row } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '去掉卫衣' }))
    await waitFor(() => expect(within(dialog).queryByText('卫衣')).not.toBeInTheDocument())
    expect(writes.at(-1)).toEqual({
      body: {
        categories: ['短靴'],
        document: '# 出场元素\n\n第一版拆解',
        version: 1,
        videoTypes: ['try_on'],
      },
      method: 'PATCH',
      path: `/references/${row.id}`,
    })

    await user.click(within(dialog).getByRole('button', { name: '添加品类' }))
    const picker = await screen.findByRole('dialog', { name: '添加品类' })
    await user.type(within(picker).getByRole('combobox', { name: '搜索品类' }), '拖鞋')
    await user.click(within(picker).getByRole('option', { name: '拖鞋' }))
    await waitFor(() =>
      expect(writes.at(-1)?.body).toMatchObject({ categories: ['短靴', '拖鞋'], version: 2 }),
    )
    expect(await within(dialog).findByText('拖鞋')).toBeVisible()
  })

  it('编辑拆解：原地换成文本框，保存带 version，回到查看看到新的拆解', async () => {
    const writes = recordWrites()
    const user = userEvent.setup()
    const { dialog } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '编辑拆解' }))
    const editor = within(dialog).getByRole('textbox', { name: '拆解' })
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('# 出场元素\n\n第一版拆解')
    await user.clear(editor)
    await user.type(editor, '改过的拆解')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    expect(await within(dialog).findByText('改过的拆解')).toBeVisible()
    expect(within(dialog).queryByRole('textbox', { name: '拆解' })).not.toBeInTheDocument()
    expect(writes.at(-1)?.body).toMatchObject({ document: '改过的拆解', version: 1 })
  })

  it('保存时版本对不上（409）：底栏原地提示，编辑框里的修改留着；「取消」收起提示接着编辑，「刷新」读回最新的', async () => {
    server.use(
      http.patch('*/api/references/:id', () =>
        HttpResponse.json({ detail: 'version mismatch' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    const { dialog } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '编辑拆解' }))
    await user.type(within(dialog).getByRole('textbox', { name: '拆解' }), '，补一句')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('该拆解已被修改，刷新将丢弃本次修改')
    expect(alert).not.toHaveTextContent('version mismatch')
    const editor = within(dialog).getByRole('textbox', { name: '拆解' })
    expect(editor).toHaveValue('# 出场元素\n\n第一版拆解，补一句')
    const refresh = within(dialog).getByRole('button', { name: '刷新' })
    expect(refresh).toHaveFocus()
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()

    // 「取消」只收起提示，回到编辑，内容还在。
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(editor).toHaveValue('# 出场元素\n\n第一版拆解，补一句')
    expect(editor).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await within(dialog).findByRole('alert')
    await user.click(within(dialog).getByRole('button', { name: '刷新' }))
    expect(within(dialog).queryByRole('textbox', { name: '拆解' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('第一版拆解')).toBeVisible()
  })

  it('编辑时按 Esc 先退回查看，详情不关', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '编辑拆解' }))
    await user.keyboard('{Escape}')

    expect(within(dialog).queryByRole('textbox', { name: '拆解' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: '编辑拆解' })).toHaveFocus()
  })

  it('重新拆解：底栏原地确认，确认后排队、编辑先不能点', async () => {
    const writes = recordWrites()
    const user = userEvent.setup()
    const { dialog, row } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '重新拆解' }))
    expect(
      within(dialog).getByText('重新拆解会覆盖当前的拆解和标签，包括你修改过的内容'),
    ).toBeVisible()
    const confirm = within(dialog).getByRole('button', { name: '重新拆解' })
    expect(confirm).toHaveFocus()
    await user.click(confirm)

    expect(await within(dialog).findByText(/排队中/)).toBeVisible()
    expect(writes.at(-1)).toMatchObject({
      method: 'POST',
      path: `/references/${row.id}/breakdowns`,
    })
    expect(within(dialog).getByRole('button', { name: '编辑拆解' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '重新拆解' })).toBeDisabled()
  })

  it('移除：从「更多操作」进，底栏确认后关掉详情', async () => {
    const writes = recordWrites()
    const onReference = vi.fn()
    const user = userEvent.setup()
    const { dialog, row } = await openDetail({}, onReference)
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '从资料库移除' }))
    await user.click(within(dialog).getByRole('button', { name: '移除' }))

    await waitFor(() => expect(onReference).toHaveBeenLastCalledWith(null))
    expect(writes.at(-1)).toMatchObject({ method: 'DELETE', path: `/references/${row.id}` })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('别人的：只能看、复制拆解与下载，没有编辑、重拆、移除，标签不能改', async () => {
    const { dialog } = await openDetail({ userName: 'Maya.Cheng' })
    await within(dialog).findByText('第一版拆解')

    expect(within(dialog).getByRole('button', { name: '复制拆解' })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: '下载视频' })).toBeVisible()
    for (const name of ['编辑拆解', '重新拆解', '更多操作', '去掉卫衣', '添加品类'])
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument()
  })

  it.each([
    ['video_unreadable', null, /换一条视频/],
    ['model_call_failed', '# 上一次的拆解', /下方仍是上一次的拆解/],
  ] as const)(
    '拆解失败（%s）：按原因说一句给人看的话，不出现原因代码',
    async (errorCode, document, message) => {
      const { dialog } = await openDetail({ breakdownStatus: 'failed', document, errorCode })

      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).not.toHaveTextContent(errorCode)
      expect(within(dialog).getByRole('button', { name: '重新拆解' })).toBeEnabled()
    },
  )

  it('拆解中：标签处说拆完自动打，正文是占位，编辑与重拆先不能点', async () => {
    const { dialog } = await openDetail({
      breakdownStatus: 'running',
      categories: [],
      document: null,
      videoTypes: [],
    })

    expect(await within(dialog).findByText(/正在拆解/)).toBeVisible()
    expect(within(dialog).getAllByText('拆解完成后自动打标签')).toHaveLength(2)
    expect(within(dialog).getByRole('button', { name: '编辑拆解' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '重新拆解' })).toBeDisabled()
  })
})
