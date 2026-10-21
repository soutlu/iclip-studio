import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, Toaster } from '@/shared/ui/toast'
import { pasteFilesIntoComposer } from '@/testing/editor'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { mockTagId } from '@/testing/mocks/library-tags'
import { addMockReference, resetMockReferences } from '@/testing/mocks/references'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { stubScrollViewport } from '@/testing/scroll-viewport'
import { DEFAULT_REFERENCE_SCOPE, type ReferenceScope } from '../references.api'
import { ReferencesRoute } from './references-route'

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

const recordListQueries = () => {
  const queries: URLSearchParams[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/api/references')) queries.push(url.searchParams)
  })
  return queries
}

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

const tags = (...names: string[]) => names.map(mockTagId)

const MINE_TAGGED = {
  createdAt: '2026-09-23T11:00:00Z',
  id: '5ef00000-0000-4000-8000-0000000000a1',
  tagIds: tags('AMZ', '短靴', '卫衣', '动态上身展示'),
}
const MINE_TITLE = 'AMZ · 短靴 · 卫衣 · 动态上身展示'

beforeEach(() => {
  stubScrollViewport({ role: 'main', name: '资料库' }, { width: 1200, height: 900 })
  resetMockReferences([])
})

afterEach(() => {
  toast.dismiss()
  vi.unstubAllGlobals()
})

describe('参考视频列表', () => {
  it('卡片：状态角标、标签行（按标签树的先后；没有标签是「未标注」，没拆完说拆完自动打）、属主；底部计数', async () => {
    resetMockReferences([
      MINE_TAGGED,
      { breakdownStatus: 'running', createdAt: '2026-09-23T11:30:00Z', document: null },
      { breakdownStatus: 'pending', createdAt: '2026-09-23T11:40:00Z', document: null },
      {
        breakdownStatus: 'failed',
        createdAt: '2026-09-23T10:00:00Z',
        document: null,
        errorCode: 'video_unreadable',
      },
      { createdAt: '2026-09-23T09:00:00Z', userName: 'Maya.Cheng' },
      {
        createdAt: '2026-09-23T08:00:00Z',
        tagIds: tags('DTC'),
        tagStatus: 'running',
      },
      {
        createdAt: '2026-09-23T07:00:00Z',
        tagError: 'model_failed',
        tagIds: tags('INS'),
        tagStatus: 'failed',
      },
    ])
    await renderWithProviders(<Harness />)

    const tagged = await screen.findByRole('article', { name: MINE_TITLE })
    expect(within(tagged).getByRole('button', { name: /tester/ })).toBeVisible()
    const [pending, running] = screen.getAllByRole('article')
    expect(within(pending as HTMLElement).getByText('排队中')).toBeVisible()
    expect(within(running as HTMLElement).getByText('拆解中')).toBeVisible()
    expect(within(pending as HTMLElement).getByText('拆解完成后自动打标签')).toBeVisible()
    expect(screen.getByText('拆解失败')).toBeVisible()
    expect(screen.getAllByRole('article', { name: '未标注' })).toHaveLength(2)
    // 打标中与没打成：人工维度的标签照旧显示，角标说打标的状态。
    expect(within(screen.getByRole('article', { name: 'DTC' })).getByText('正在打标')).toBeVisible()
    expect(within(screen.getByRole('article', { name: 'INS' })).getByText('打标失败')).toBeVisible()
    expect(screen.getByText('共 7 条')).toBeVisible()
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
  })

  it('一条都没有时整块列表区是拖放区，能选文件', async () => {
    await renderWithProviders(<Harness />)

    expect(await screen.findByText('将视频拖到此处或在本页粘贴，可直接上传')).toBeVisible()
    expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()
  })

  it('标签筛选：每个维度一个下拉，按标签树的先后', async () => {
    resetMockReferences([MINE_TAGGED])
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    const triggers = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
      .filter((name) => /^(品牌|平台&渠道|品类|场景|内容结构)：/.test(name ?? ''))
    expect(triggers).toEqual([
      '品牌：品牌',
      '平台&渠道：平台&渠道',
      '品类：品类',
      '场景：场景',
      '内容结构：内容结构',
    ])
  })

  it('两层的维度：大类可勾、小类缩进在它下面，条数取自标签树；选大类也算小类，勾一项写进 tags 重查一次、弹层留着；「全部」清掉', async () => {
    resetMockReferences([
      { createdAt: '2026-09-23T11:00:00Z', tagIds: tags('拖鞋', '对比测评') },
      { createdAt: '2026-09-23T10:00:00Z', tagIds: tags('短靴', '开箱测评型') },
      { createdAt: '2026-09-23T09:00:00Z', tagIds: tags('拖鞋', '图文幻灯片') },
    ])
    const queries = recordListQueries()
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('button', { name: '内容结构：内容结构' }))
    const popup = await screen.findByRole('dialog', { name: '选择内容结构' })
    const names = within(popup)
      .getAllByRole('option')
      .map((option) => option.textContent)
    // 大类带判断句；条数含下级。
    expect(names.slice(15, 19)).toEqual([
      '开箱测评型拆包装上手，或在片中做测试、对比2',
      '标准开箱流程0',
      '极速上手体验0',
      '对比测评1',
    ])

    await user.type(within(popup).getByRole('combobox', { name: '搜索内容结构' }), '开箱测评')
    await user.click(within(popup).getByRole('option', { name: /开箱测评型/ }))
    await waitFor(() => expect(cardNames()).toEqual(['拖鞋 · 对比测评', '短靴 · 开箱测评型']))
    expect(queries.at(-1)?.getAll('tags')).toEqual([mockTagId('开箱测评型')])
    expect(onScope).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: [mockTagId('开箱测评型')] }),
    )
    expect(screen.getByText('找到 2 条')).toBeVisible()
    expect(screen.getByRole('dialog', { name: '选择内容结构' })).toBeVisible()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('radio', { name: '全部' }))
    await waitFor(() => expect(cardNames()).toHaveLength(3))
    expect(queries.at(-1)?.has('tags')).toBe(false)
  })

  it('不同维度都要命中：品类与内容结构各选一项，交回的 tags 按树的先后', async () => {
    resetMockReferences([
      { createdAt: '2026-09-23T11:00:00Z', tagIds: tags('拖鞋', '对比测评') },
      { createdAt: '2026-09-23T10:00:00Z', tagIds: tags('短靴', '开箱测评型') },
      { createdAt: '2026-09-23T09:00:00Z', tagIds: tags('拖鞋', '图文幻灯片') },
    ])
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('button', { name: '内容结构：内容结构' }))
    const structure = await screen.findByRole('dialog', { name: '选择内容结构' })
    await user.type(within(structure).getByRole('combobox', { name: '搜索内容结构' }), '对比')
    await user.click(within(structure).getByRole('option', { name: /对比测评/ }))
    await screen.findByText('找到 1 条')

    await user.click(screen.getByRole('button', { name: '品类：品类' }))
    const category = await screen.findByRole('dialog', { name: '选择品类' })
    await user.type(within(category).getByRole('combobox', { name: '搜索品类' }), '短靴')
    await user.click(within(category).getByRole('option', { name: /短靴/ }))

    await waitFor(() =>
      expect(queries.at(-1)?.getAll('tags')).toEqual([mockTagId('短靴'), mockTagId('对比测评')]),
    )
    expect(await screen.findByText('暂无匹配的参考视频，请更换关键词或清除筛选')).toBeVisible()
  })

  it('按人筛：点卡片上的属主；候选取自后端的属主名单，还没翻到的属主也能选', async () => {
    resetMockReferences([
      ...Array.from({ length: 24 }, (_, index) => ({
        createdAt: new Date(Date.UTC(2026, 8, 23, 11, index)).toISOString(),
        userName: 'Maya.Cheng',
      })),
      { createdAt: '2026-09-22T10:00:00Z', userName: 'tester' },
    ])
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

  it('还有没拆完或没打完标的行就轮询，打完后自动换上标签，筛选里的条数跟着变', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const row = addMockReference({ breakdownStatus: 'running', document: null })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await renderWithProviders(<Harness />)
      expect(await screen.findByText('拆解中')).toBeVisible()

      resetMockReferences([{ ...row, breakdownStatus: 'completed', tagStatus: 'running' }])
      await vi.advanceTimersByTimeAsync(5000)
      expect(await screen.findByText('正在打标')).toBeVisible()

      resetMockReferences([{ ...row, breakdownStatus: 'completed', tagIds: tags('拖鞋') }])
      await vi.advanceTimersByTimeAsync(5000)
      expect(await screen.findByRole('article', { name: '拖鞋' })).toBeVisible()
      expect(screen.queryByText('正在打标')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: '品类：品类' }))
      const popup = await screen.findByRole('dialog', { name: '选择品类' })
      await user.type(within(popup).getByRole('combobox', { name: '搜索品类' }), '拖鞋')
      expect(
        within(popup)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toContain('拖鞋1')
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
    const existing = addMockReference(MINE_TAGGED)
    server.use(http.post('*/api/references', () => HttpResponse.json(existing, { status: 200 })))
    const onReference = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onReference={onReference} />)
    await screen.findByRole('article', { name: MINE_TITLE })

    await user.upload(fileInput(), video('同一条.mp4'))

    expect(await screen.findByText('该视频此前已上传，已打开其详情')).toBeVisible()
    expect(onReference).toHaveBeenLastCalledWith(existing.id)
    expect(await screen.findByRole('dialog', { name: MINE_TITLE })).toBeVisible()
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
  const openDetail = async (
    overrides: Parameters<typeof addMockReference>[0] = {},
    onReference?: (id: string | null) => void,
  ) => {
    const row = addMockReference({
      ...MINE_TAGGED,
      document: '# 出场元素\n\n第一版拆解',
      ...overrides,
    })
    await renderWithProviders(
      <Harness initialReference={row.id} {...(onReference ? { onReference } : {})} />,
    )
    const dialog = await screen.findByRole('dialog')
    return { dialog, row }
  }

  it('属主：每个维度一行；标签能去掉，「+」从这一维度里加；每次改动把所有维度的标签整份 PUT', async () => {
    const writes = recordWrites()
    const user = userEvent.setup()
    const { dialog, row } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    expect(
      within(dialog)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label'))
        .filter((name) => ['品牌', '平台&渠道', '品类', '场景', '内容结构'].includes(name ?? '')),
    ).toEqual(['品牌', '平台&渠道', '品类', '场景', '内容结构'])

    await user.click(within(dialog).getByRole('button', { name: '移除卫衣' }))
    await waitFor(() => expect(within(dialog).queryByText('卫衣')).not.toBeInTheDocument())
    expect(writes.at(-1)).toEqual({
      body: { tagIds: tags('AMZ', '短靴', '动态上身展示') },
      method: 'PUT',
      path: `/references/${row.id}/tags`,
    })

    // 两层的维度：清单里大类与小类都在，选小类加进去。
    await user.click(within(dialog).getByRole('button', { name: '添加内容结构' }))
    const picker = await screen.findByRole('dialog', { name: '添加内容结构' })
    await user.type(within(picker).getByRole('combobox', { name: '搜索内容结构' }), '开箱')
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['开箱测评型', '标准开箱流程'])
    await user.click(within(picker).getByRole('option', { name: '标准开箱流程' }))
    await waitFor(() =>
      expect(writes.at(-1)?.body).toEqual({
        tagIds: tags('AMZ', '短靴', '动态上身展示', '标准开箱流程'),
      }),
    )
    expect(await within(dialog).findByText('标准开箱流程')).toBeVisible()
    expect(writes.some((write) => write.method === 'PATCH')).toBe(false)
  })

  it('AI 打的维度名字旁有提示：重新打标会重写这些标签；人工维度没有', async () => {
    const { dialog } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    for (const name of ['品类', '场景', '内容结构'])
      expect(
        within(within(dialog).getByRole('group', { name })).getByRole('img', {
          name: /重新打标.*重写/,
        }),
      ).toBeInTheDocument()
    for (const name of ['品牌', '平台&渠道'])
      expect(
        within(within(dialog).getByRole('group', { name })).queryByRole('img'),
      ).not.toBeInTheDocument()
  })

  it('正在打标：说明一句，标签先不能改，「重新打标」不能点', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDetail({ tagStatus: 'running' })
    await within(dialog).findByText('第一版拆解')

    expect(within(dialog).getByRole('status')).toHaveTextContent('正在打标')
    expect(within(dialog).getByRole('button', { name: '移除卫衣' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '添加品类' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(within(dialog).getByRole('button', { name: '更多操作' }))
    expect(await screen.findByRole('menuitem', { name: '重新打标' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('打标失败：按原因说一句给人看的话，不出现原因代码；点「重新打标」原地确认后提交，随即显示正在打标', async () => {
    const writes = recordWrites()
    const user = userEvent.setup()
    const { dialog, row } = await openDetail({
      tagError: 'model_call_failed',
      tagIds: tags('AMZ'),
      tagStatus: 'failed',
    })
    await within(dialog).findByText('第一版拆解')

    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent(/打标服务连接失败/)
    expect(alert).not.toHaveTextContent('model_call_failed')

    await user.click(within(alert).getByRole('button', { name: '重新打标' }))
    expect(
      within(dialog).getByText(/重新打标会按当前的拆解重写品类、场景、内容结构的标签/),
    ).toBeVisible()
    const confirm = within(dialog).getByRole('button', { name: '重新打标' })
    expect(confirm).toHaveFocus()
    await user.click(confirm)

    expect(await within(dialog).findByText(/正在打标/)).toBeVisible()
    expect(writes.at(-1)).toMatchObject({ method: 'POST', path: `/references/${row.id}/tagging` })
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('拆解没完成时不能重新打标', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDetail({ breakdownStatus: 'running', document: null })
    await within(dialog).findByText(/正在拆解/)
    await user.click(within(dialog).getByRole('button', { name: '更多操作' }))
    expect(await screen.findByRole('menuitem', { name: '重新打标' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('别人的没打成：只说原因，没有「重新打标」', async () => {
    const { dialog } = await openDetail({
      tagError: 'timeout',
      tagStatus: 'failed',
      userName: 'Maya.Cheng',
    })
    await within(dialog).findByText('第一版拆解')

    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent('打标超时')
    expect(alert).not.toHaveTextContent('「重新打标」')
    expect(within(dialog).queryByRole('button', { name: '重新打标' })).not.toBeInTheDocument()
  })

  it('改标签时正在打标（409）：提示一句并读回最新的', async () => {
    server.use(
      http.put('*/api/references/:id/tags', () =>
        HttpResponse.json({ detail: '正在打标' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    const { dialog } = await openDetail()
    await within(dialog).findByText('第一版拆解')

    await user.click(within(dialog).getByRole('button', { name: '移除卫衣' }))
    expect(await screen.findByText('正在打标，标签无法保存；请在打标完成后重试')).toBeVisible()
    expect(within(dialog).getByText('卫衣')).toBeVisible()
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
      within(dialog).getByText(
        '重新拆解会覆盖当前的拆解，并重写品类、场景、内容结构的标签，包括手动修改过的内容',
      ),
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
    for (const name of ['编辑拆解', '重新拆解', '更多操作', '移除卫衣', '添加品类'])
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument()
  })

  it.each([
    ['video_unreadable', null, /请上传其他视频/],
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

  describe('试生成', () => {
    const TEST_VIDEO = {
      createdAt: '2026-09-23T11:30:00Z',
      errorMessage: null,
      stale: false,
      status: 'completed',
      url: 'https://assets.example.com/test.mp4',
    } as const

    /** jsdom 不解码视频：给视频报一个画面尺寸，再在原片上发出 loadedmetadata，当作读到了元数据。 */
    const loadOriginal = (dialog: HTMLElement, width: number, height: number) => {
      vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(width)
      vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(height)
      fireEvent.loadedMetadata(within(dialog).getByLabelText('原片', { selector: 'video' }))
    }

    const testWrites = (writes: ReturnType<typeof recordWrites>) =>
      writes.filter((write) => write.path.endsWith('/test-generations'))

    it.each([
      [720, 1280, '9:16'],
      [1920, 1080, '16:9'],
    ] as const)(
      '属主未试生成：量到原片画幅前不能提交；原片 %i×%i 时带 %s 提交，随即显示生成中',
      async (width, height, aspectRatio) => {
        const writes = recordWrites()
        const user = userEvent.setup()
        const { dialog, row } = await openDetail()
        await within(dialog).findByText('第一版拆解')

        expect(within(dialog).getByText('用拆解试生成')).toBeVisible()
        const start = within(dialog).getByRole('button', { name: '试生成' })
        expect(start).toBeDisabled()

        loadOriginal(dialog, width, height)
        await user.click(start)

        const status = await within(dialog).findByRole('status')
        expect(status).toHaveTextContent(/试生成中 · \d+:\d{2}/)
        expect(testWrites(writes)).toEqual([
          { body: { aspectRatio }, method: 'POST', path: `/references/${row.id}/test-generations` },
        ])
        expect(within(dialog).queryByRole('button', { name: '试生成' })).not.toBeInTheDocument()
      },
    )

    it('提交失败：toast 显示后端给的原因', async () => {
      server.use(
        http.post('*/api/references/:id/test-generations', () =>
          HttpResponse.json({ detail: '上一次试生成尚未结束' }, { status: 409 }),
        ),
      )
      const user = userEvent.setup()
      const { dialog } = await openDetail()
      await within(dialog).findByText('第一版拆解')

      loadOriginal(dialog, 720, 1280)
      await user.click(within(dialog).getByRole('button', { name: '试生成' }))

      expect(await screen.findByText('试生成失败：上一次试生成尚未结束')).toBeVisible()
    })

    it('别人的、未试生成：没有「试生成」，显示暂无', async () => {
      const { dialog } = await openDetail({ userName: 'Maya.Cheng' })
      await within(dialog).findByText('第一版拆解')

      expect(within(dialog).getByText('暂无试生成')).toBeVisible()
      for (const name of ['试生成', '重新试生成'])
        expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument()
    })

    it('拆解未完成：「试生成」置灰（aria-disabled），点了不提交', async () => {
      const writes = recordWrites()
      const user = userEvent.setup()
      const { dialog } = await openDetail({ breakdownStatus: 'running', document: null })
      await within(dialog).findByText(/正在拆解/)

      loadOriginal(dialog, 720, 1280)
      const start = within(dialog).getByRole('button', { name: '试生成' })
      expect(start).toHaveAttribute('aria-disabled', 'true')
      await user.click(start)

      expect(testWrites(writes)).toEqual([])
    })

    it('完成：第二个播放器是试生成；属主有「重新试生成」，没有过时提醒', async () => {
      const { dialog } = await openDetail({ testVideo: TEST_VIDEO })
      await within(dialog).findByText('第一版拆解')

      expect(within(dialog).getByRole('group', { name: '播放器：原片' })).toBeVisible()
      expect(within(dialog).getByRole('group', { name: '播放器：试生成' })).toBeVisible()
      expect(within(dialog).getByRole('button', { name: '重新试生成' })).toBeVisible()
      expect(within(dialog).queryByText(/拆解已更新/)).not.toBeInTheDocument()
    })

    it('能改但不是属主本人（canEdit 为真，如治理者）：没有「试生成」', async () => {
      const row = addMockReference({ document: '# 出场元素\n\n第一版拆解', userName: 'Maya.Cheng' })
      server.use(
        // 同一路径也匹配 /references/filters：只接管这一行，其余交给默认 mock。
        http.get('*/api/references/:id', ({ params }) =>
          params['id'] === row.id ? HttpResponse.json({ ...row, canEdit: true }) : undefined,
        ),
      )
      await renderWithProviders(<Harness initialReference={row.id} />)
      const dialog = await screen.findByRole('dialog')
      await within(dialog).findByText('第一版拆解')

      expect(within(dialog).getByRole('button', { name: '编辑拆解' })).toBeVisible()
      expect(within(dialog).getByText('暂无试生成')).toBeVisible()
      expect(within(dialog).queryByRole('button', { name: '试生成' })).not.toBeInTheDocument()
    })

    it('别人的、已完成：能看试生成，没有「重新试生成」', async () => {
      const { dialog } = await openDetail({ testVideo: TEST_VIDEO, userName: 'Maya.Cheng' })
      await within(dialog).findByText('第一版拆解')

      expect(within(dialog).getByRole('group', { name: '播放器：试生成' })).toBeVisible()
      expect(within(dialog).queryByRole('button', { name: '重新试生成' })).not.toBeInTheDocument()
    })

    it('拆解改过（stale）：试生成上方提醒该结果按更新前的拆解生成', async () => {
      const { dialog } = await openDetail({ testVideo: { ...TEST_VIDEO, stale: true } })
      await within(dialog).findByText('第一版拆解')

      expect(within(dialog).getByText('拆解已更新，该结果按更新前的拆解生成')).toBeVisible()
    })

    it('失败：显示上游原因；属主点「重新试生成」再提交一次', async () => {
      const writes = recordWrites()
      const user = userEvent.setup()
      const { dialog, row } = await openDetail({
        testVideo: {
          ...TEST_VIDEO,
          errorMessage: '视频时长 45 秒，超出模型支持的时长',
          status: 'failed',
          url: null,
        },
      })
      await within(dialog).findByText('第一版拆解')

      const alert = within(dialog).getByRole('alert')
      expect(alert).toHaveTextContent('试生成失败')
      expect(alert).toHaveTextContent('视频时长 45 秒，超出模型支持的时长')

      loadOriginal(dialog, 720, 1280)
      await user.click(within(alert).getByRole('button', { name: '重新试生成' }))

      expect(await within(dialog).findByRole('status')).toHaveTextContent(/试生成中/)
      expect(testWrites(writes)).toEqual([
        {
          body: { aspectRatio: '9:16' },
          method: 'POST',
          path: `/references/${row.id}/test-generations`,
        },
      ])
    })
  })

  it('拆解中：标签处说拆完自动打，正文是占位，编辑与重拆先不能点', async () => {
    const { dialog } = await openDetail({
      breakdownStatus: 'running',
      document: null,
      tagIds: [],
    })

    expect(await within(dialog).findByText(/正在拆解/)).toBeVisible()
    expect(within(dialog).getByText('拆解完成后自动打标签')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: '编辑拆解' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '重新拆解' })).toBeDisabled()
  })
})
