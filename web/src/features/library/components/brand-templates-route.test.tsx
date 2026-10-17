import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubFontLoading } from '@/testing/font-loading'
import { brandTemplateHandlers, findMockBrandTemplate } from '@/testing/mocks/brand-templates'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { BrandTemplateScope } from '../brand-templates'
import { BrandTemplatesRoute } from './brand-templates-route'

function Harness({
  canManage = true,
  canUpload = true,
}: {
  canManage?: boolean
  canUpload?: boolean
}) {
  const [scope, setScope] = useState<BrandTemplateScope>({
    q: '',
    brand: undefined,
    includeDisabled: false,
  })
  return (
    <BrandTemplatesRoute
      tabs={null}
      canManage={canManage}
      canUpload={canUpload}
      scope={scope}
      onScopeChange={setScope}
    />
  )
}

const MANAGER = ['generation:read', 'users:manage', 'uploads:write']

let fonts: ReturnType<typeof stubFontLoading>

beforeEach(() => {
  server.use(...brandTemplateHandlers(() => MANAGER))
  fonts = stubFontLoading()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fonts.restore()
})

const putBodies = () => {
  const bodies: unknown[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'PUT' && new URL(request.url).pathname.includes('/brands/'))
      void request
        .clone()
        .json()
        .then((body: unknown) => bodies.push(body))
  })
  return bodies
}

describe('品牌设置', () => {
  it('普通读者看到各品牌的标语与强调色，没有设过的明确显示暂无，不能编辑', async () => {
    server.use(...brandTemplateHandlers(() => ['generation:read']))
    await renderWithProviders(<Harness canManage={false} />)
    const brand = await screen.findByRole('article', { name: '品牌：示例品牌' })
    expect(within(brand).getByText('一步一风景')).toBeVisible()
    expect(within(brand).getByText('#e4002b')).toBeVisible()
    const plain = screen.getByRole('article', { name: '品牌：通用' })
    expect(within(plain).getByText('暂无标语')).toBeVisible()
    expect(within(plain).getByText('暂无强调色')).toBeVisible()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加品牌' })).toBeNull()
  })

  it('治理者添加没有字体的新品牌，保存后出现在品牌列表里', async () => {
    const paths: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PUT') paths.push(decodeURIComponent(new URL(request.url).pathname))
    })
    const bodies = putBodies()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.click(screen.getByRole('button', { name: '添加品牌' }))
    const card = screen.getByRole('article', { name: '添加品牌' })
    expect(screen.queryByRole('button', { name: '添加品牌' })).toBeNull()
    expect(within(card).getByLabelText('品牌名')).toHaveFocus()
    await user.type(within(card).getByLabelText('品牌名'), ' 新锐 ')
    await user.type(within(card).getByLabelText('标语'), '轻装出发')
    await user.type(within(card).getByLabelText('强调色'), '#112233')
    await user.click(within(card).getByRole('button', { name: '保存品牌设置' }))
    const created = await screen.findByRole('article', { name: '品牌：新锐' })
    expect(within(created).getByText('轻装出发')).toBeVisible()
    expect(screen.queryByRole('article', { name: '添加品牌' })).toBeNull()
    expect(paths).toEqual(['/api/brand-templates/brands/新锐'])
    expect(bodies).toEqual([{ slogan: '轻装出发', accentColor: '#112233' }])
  })

  it('添加时品牌名已存在则提示并更新该品牌，不重复列出', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.click(screen.getByRole('button', { name: '添加品牌' }))
    const card = screen.getByRole('article', { name: '添加品牌' })
    await user.type(within(card).getByLabelText('品牌名'), '示例品牌')
    expect(within(card).getByRole('status')).toHaveTextContent(
      '该品牌已存在，保存后将覆盖其标语与强调色',
    )
    await user.type(within(card).getByLabelText('标语'), '新标语')
    await user.click(within(card).getByRole('button', { name: '保存品牌设置' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: '添加品牌' })).toBeNull())
    expect(screen.getAllByRole('article', { name: '品牌：示例品牌' })).toHaveLength(1)
    expect(
      within(screen.getByRole('article', { name: '品牌：示例品牌' })).getByText('新标语'),
    ).toBeVisible()
  })

  it('品牌名为空时阻止保存，取消后收起添加卡片', async () => {
    const bodies = putBodies()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.click(screen.getByRole('button', { name: '添加品牌' }))
    const card = screen.getByRole('article', { name: '添加品牌' })
    await user.type(within(card).getByLabelText('品牌名'), '   ')
    await user.click(within(card).getByRole('button', { name: '保存品牌设置' }))
    expect(within(card).getByRole('alert')).toHaveTextContent('品牌名为空，无法保存；请填写品牌名')
    expect(bodies).toEqual([])
    await user.click(within(card).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('article', { name: '添加品牌' })).toBeNull()
    expect(screen.getByRole('button', { name: '添加品牌' })).toHaveFocus()
  })

  it('治理者在卡片里修改标语与强调色，色值统一小写保存，清空发送 null', async () => {
    const bodies = putBodies()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    let brand = await screen.findByRole('article', { name: '品牌：通用' })
    await user.click(within(brand).getByRole('button', { name: '编辑' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.type(within(brand).getByLabelText('标语'), ' 好穿不累 ')
    await user.type(within(brand).getByLabelText('强调色'), '#0055A4')
    expect(within(brand).getByLabelText('选择强调色')).toHaveValue('#0055a4')
    await user.click(within(brand).getByRole('button', { name: '保存品牌设置' }))
    brand = await screen.findByRole('article', { name: '品牌：通用' })
    expect(await within(brand).findByText('好穿不累')).toBeVisible()
    expect(within(brand).getByText('#0055a4')).toBeVisible()
    expect(bodies[0]).toEqual({ slogan: '好穿不累', accentColor: '#0055A4' })

    await user.click(within(brand).getByRole('button', { name: '编辑' }))
    await user.clear(within(brand).getByLabelText('标语'))
    await user.clear(within(brand).getByLabelText('强调色'))
    await user.click(within(brand).getByRole('button', { name: '保存品牌设置' }))
    expect(await within(brand).findByText('暂无标语')).toBeVisible()
    expect(within(brand).getByText('暂无强调色')).toBeVisible()
    expect(bodies[1]).toEqual({ slogan: null, accentColor: null })
  })

  it('取色器选择的颜色写入色值', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const brand = await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.click(within(brand).getByRole('button', { name: '编辑' }))
    fireEvent.change(within(brand).getByLabelText('选择强调色'), {
      target: { value: '#112233' },
    })
    expect(within(brand).getByLabelText('强调色')).toHaveValue('#112233')
  })

  it('色值格式不正确时阻止保存且不发请求', async () => {
    const bodies = putBodies()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const brand = await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.click(within(brand).getByRole('button', { name: '编辑' }))
    const accent = within(brand).getByLabelText('强调色')
    await user.clear(accent)
    await user.type(accent, 'e4002b')
    expect(accent).toHaveAttribute('aria-invalid', 'true')
    await user.click(within(brand).getByRole('button', { name: '保存品牌设置' }))
    expect(within(brand).getByRole('alert')).toHaveTextContent(
      '强调色格式不正确，无法保存；请填写 #RRGGBB 格式的色值',
    )
    expect(bodies).toEqual([])
  })

  it('保存失败显式提示，保留正在编辑的内容', async () => {
    server.use(
      http.put('*/api/brand-templates/brands/:brand', () =>
        HttpResponse.json({ detail: '没有维护权限' }, { status: 403 }),
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const brand = await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.click(within(brand).getByRole('button', { name: '编辑' }))
    const slogan = within(brand).getByLabelText('标语')
    await user.clear(slogan)
    await user.type(slogan, '新标语')
    await user.click(within(brand).getByRole('button', { name: '保存品牌设置' }))
    expect(await within(brand).findByRole('alert')).toHaveTextContent('没有维护权限')
    expect(slogan).toHaveValue('新标语')
  })

  it('按品牌筛选同时作用于品牌与字体', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: '品牌：示例品牌' })
    await user.selectOptions(screen.getByRole('combobox', { name: '筛选品牌' }), '通用')
    expect(screen.queryByRole('article', { name: '品牌：示例品牌' })).toBeNull()
    expect(screen.getByRole('article', { name: '品牌：通用' })).toBeVisible()
    expect(screen.getByRole('article', { name: '示例字体' })).toBeVisible()
    expect(screen.queryByRole('article', { name: '品牌标题字体' })).toBeNull()
  })
})

describe('字体资源', () => {
  it('没有上传权限的治理者仍可维护已有字体，上传入口不出现', async () => {
    await renderWithProviders(<Harness canUpload={false} />)
    const card = await screen.findByRole('article', { name: '品牌标题字体' })
    expect(screen.queryByRole('button', { name: '上传字体' })).toBeNull()
    expect(within(card).getByRole('button', { name: '编辑' })).toBeVisible()
    expect(within(card).getByRole('button', { name: '停用' })).toBeVisible()
  })

  it('普通读者只看到在用字体，可预览，不能维护或查看已停用', async () => {
    server.use(...brandTemplateHandlers(() => ['generation:read']))
    const queries: URLSearchParams[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/brand-templates')) queries.push(url.searchParams)
    })
    const user = userEvent.setup()
    await renderWithProviders(<Harness canManage={false} />)
    await screen.findByRole('article', { name: '品牌标题字体' })
    expect(screen.queryByRole('article', { name: '旧版标题字体' })).toBeNull()
    expect(screen.queryByRole('button', { name: '上传字体' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '显示已停用字体' })).toBeNull()
    expect(queries.every((query) => !query.has('includeDisabled'))).toBe(true)
    await user.click(screen.getByRole('button', { name: '预览字体：品牌标题字体' }))
    expect(screen.getByRole('dialog', { name: '品牌标题字体' })).toBeVisible()
  })

  it('治理者编辑、停用与恢复，更新后列表同步', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    let card = await screen.findByRole('article', { name: '品牌标题字体' })
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    const dialog = screen.getByRole('dialog', { name: '编辑字体' })
    await user.clear(within(dialog).getByLabelText('名称'))
    await user.type(within(dialog).getByLabelText('名称'), '新品标题字体')
    await user.click(within(dialog).getByRole('button', { name: '保存字体' }))
    card = await screen.findByRole('article', { name: '新品标题字体' })
    await user.click(within(card).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: '新品标题字体' })).toBeNull())
    await user.click(screen.getByRole('checkbox', { name: '显示已停用字体' }))
    card = await screen.findByRole('article', { name: '新品标题字体' })
    expect(within(card).getByText('已停用')).toBeVisible()
    await user.click(within(card).getByRole('button', { name: '恢复使用' }))
    await waitFor(() => expect(within(card).queryByText('已停用')).toBeNull())
  })

  it('维护失败显式提示，列表保留原状态', async () => {
    server.use(
      http.patch('*/api/brand-templates/:id', () =>
        HttpResponse.json({ detail: '没有维护权限' }, { status: 403 }),
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: '品牌标题字体' })
    await user.click(within(card).getByRole('button', { name: '停用' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没有维护权限')
    expect(card).toBeVisible()
    expect(within(card).queryByText('已停用')).toBeNull()
  })

  it('品牌可修改与清空，清空时发送 null', async () => {
    const patches: unknown[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH')
        void request
          .clone()
          .json()
          .then((body) => patches.push(body))
    })
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: '品牌标题字体' })
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    let dialog = screen.getByRole('dialog', { name: '编辑字体' })
    await user.clear(within(dialog).getByLabelText('品牌'))
    await user.type(within(dialog).getByLabelText('品牌'), ' 新品牌 ')
    await user.click(within(dialog).getByRole('button', { name: '保存字体' }))
    expect(await within(card).findByText('新品牌')).toBeVisible()
    expect(patches[0]).toEqual({ name: '品牌标题字体', brand: '新品牌' })
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    dialog = screen.getByRole('dialog', { name: '编辑字体' })
    await user.clear(within(dialog).getByLabelText('品牌'))
    await user.click(within(dialog).getByRole('button', { name: '保存字体' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(card).queryByText('新品牌')).toBeNull()
    expect(patches[1]).toEqual({ name: '品牌标题字体', brand: null })
  })

  it('字体使用独立签名、PUT与确认，确认失败重试复用已传文件', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = []
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET') return
      const entry = { method: request.method, path, body: undefined as unknown }
      requests.push(entry)
      if (request.method === 'POST')
        void request
          .clone()
          .json()
          .then((body: unknown) => {
            entry.body = body
          })
    })
    server.use(
      http.post(
        '*/api/brand-templates/fonts/:id/confirm',
        () => HttpResponse.json({ detail: '资源登记失败，请重试' }, { status: 503 }),
        { once: true },
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await user.click(screen.getByRole('button', { name: '上传字体' }))
    const dialog = screen.getByRole('dialog', { name: '上传字体' })
    await user.type(within(dialog).getByLabelText('品牌'), '秋日品牌')
    await user.upload(
      within(dialog).getByLabelText('字体文件'),
      new File(['font'], '新品.otf', { type: 'font/otf' }),
    )
    await user.click(within(dialog).getByRole('button', { name: '保存字体' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('资源登记失败')
    await user.click(within(dialog).getByRole('button', { name: '保存字体' }))
    expect(await screen.findByRole('article', { name: '新品' })).toBeVisible()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /api/brand-templates/fonts/sign',
      expect.stringMatching(/^PUT \/mock-font-oss\//),
      expect.stringMatching(/^POST \/api\/brand-templates\/fonts\/[^/]+\/confirm$/),
      expect.stringMatching(/^POST \/api\/brand-templates\/fonts\/[^/]+\/confirm$/),
    ])
    expect(requests[2]?.path).toBe(requests[3]?.path)
    expect(requests[2]?.body).toEqual({ name: '新品', brand: '秋日品牌' })
    expect(requests[3]?.body).toEqual(requests[2]?.body)
    expect(await screen.findByRole('article', { name: '品牌：秋日品牌' })).toBeVisible()
  })

  it('实际字体加载完成之前显示加载状态，不展示替代字体预览', async () => {
    const only = findMockBrandTemplate('ba000001-0000-4000-8000-000000000005')
    server.use(http.get('*/api/brand-templates', () => HttpResponse.json({ items: [only] })))
    fonts.setMode('deferred')
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await user.click(await screen.findByRole('button', { name: '预览字体：示例字体' }))
    const dialog = screen.getByRole('dialog', { name: '示例字体' })
    expect(within(dialog).getByText('正在加载字体…')).toBeVisible()
    expect(within(dialog).queryByText('Made for your next adventure.')).toBeNull()
    expect(fonts.installed.size).toBe(0)
    await act(async () => fonts.finish())
    expect(await within(dialog).findByText('Made for your next adventure.')).toBeVisible()
    expect(fonts.installed.size).toBe(1)
  })

  it('字体加载失败显式报错，重试成功才恢复预览', async () => {
    fonts.setMode({ error: new Error('字体文件读取失败') })
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    expect((await screen.findAllByText('字体预览不可用')).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '预览字体：示例字体' }))
    const dialog = screen.getByRole('dialog', { name: '示例字体' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('字体加载失败')
    expect(within(dialog).queryByText('Made for your next adventure.')).toBeNull()
    fonts.setMode('immediate')
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByText('Made for your next adventure.')).toBeVisible()
  })

  it('缺字时阻止预览且不给重试，改回字体覆盖的文字后恢复', async () => {
    server.use(
      http.get('*/api/brand-templates/:id/font-info', () =>
        HttpResponse.json({
          family: 'Latin Only',
          weight: 400,
          style: 'normal',
          unicodeRanges: [{ start: 32, end: 126 }],
        }),
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await user.click(await screen.findByRole('button', { name: '预览字体：示例字体' }))
    const dialog = screen.getByRole('dialog', { name: '示例字体' })
    expect(await within(dialog).findByText('Made for your next adventure.')).toBeVisible()
    const input = within(dialog).getByRole('textbox', { name: '预览文字' })
    await user.clear(input)
    await user.type(input, '缺字')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('所选字体不包含部分文字')
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(within(dialog).queryByText('缺字')).toBeNull()
    await user.clear(input)
    await user.type(input, 'Available')
    expect(await within(dialog).findByText('Available')).toBeVisible()
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })
})
