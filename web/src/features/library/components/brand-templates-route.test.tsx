import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
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
    kind: undefined,
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

let fonts: ReturnType<typeof stubFontLoading>

beforeEach(() => {
  server.use(...brandTemplateHandlers(() => ['generation:read', 'users:manage', 'uploads:write']))
  fonts = stubFontLoading()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fonts.restore()
})

describe('BrandTemplatesRoute', () => {
  it.each([
    ['intro', '片头'],
    ['outro', '片尾'],
  ] as const)('%s 卡片使用淡入之后的精确截帧', async (kind, label) => {
    const template = {
      ...findMockBrandTemplate('ba000001-0000-4000-8000-000000000001'),
      name: `品牌${label}`,
      kind,
      url: 'https://media.oss-cn-shenzhen.aliyuncs.com/brand.mp4',
    }
    server.use(http.get('*/api/brand-templates', () => HttpResponse.json({ items: [template] })))
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: template.name })
    const poster = within(card).getByRole('presentation')
    expect(poster).toHaveAttribute('src', expect.stringContaining('video/snapshot,t_500,'))
    expect(poster).not.toHaveAttribute('src', expect.stringContaining('m_fast'))
  })

  it('没有上传权限的治理者仍可维护已有模板，上传入口不出现', async () => {
    await renderWithProviders(<Harness canUpload={false} />)
    const card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    expect(screen.queryByRole('button', { name: '上传资源' })).toBeNull()
    expect(within(card).getByRole('button', { name: '编辑' })).toBeVisible()
    expect(within(card).getByRole('button', { name: '停用' })).toBeVisible()
  })
  it('普通读者只看到在用模板，可预览，不能维护或查看已停用', async () => {
    server.use(...brandTemplateHandlers(() => ['generation:read']))
    const queries: URLSearchParams[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/brand-templates')) queries.push(url.searchParams)
    })
    const user = userEvent.setup()
    await renderWithProviders(<Harness canManage={false} />)
    await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    expect(screen.queryByRole('article', { name: '旧版片尾' })).toBeNull()
    expect(screen.queryByRole('button', { name: '上传资源' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '显示已停用' })).toBeNull()
    expect(queries.every((query) => !query.has('includeDisabled'))).toBe(true)
    await user.click(screen.getByRole('button', { name: '预览资源：品牌片头 · 竖版' }))
    expect(screen.getByRole('dialog', { name: '品牌片头 · 竖版' })).toBeVisible()
  })

  it('治理者编辑、停用与恢复，更新后列表同步', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    let card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    const dialog = screen.getByRole('dialog', { name: '编辑品牌资源' })
    await user.clear(within(dialog).getByLabelText('名称'))
    await user.type(within(dialog).getByLabelText('名称'), '新品片头')
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
    card = await screen.findByRole('article', { name: '新品片头' })
    await user.click(within(card).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: '新品片头' })).toBeNull())
    await user.click(screen.getByRole('checkbox', { name: '显示已停用' }))
    card = await screen.findByRole('article', { name: '新品片头' })
    expect(within(card).getByText('已停用')).toBeVisible()
    await user.click(within(card).getByRole('button', { name: '恢复使用' }))
    await waitFor(() => expect(within(card).queryByText('已停用')).toBeNull())
  })

  it('创建按视频直传协议确认后提交，服务端拒绝后重试不重复上传', async () => {
    const submitted: unknown[] = []
    let signs = 0
    let reject = true
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.endsWith('/uploads/sign')) signs += 1
    })
    server.use(
      http.post('*/api/brand-templates', async ({ request }) => {
        const body: unknown = await request.json()
        submitted.push(body)
        if (reject) return HttpResponse.json({ detail: '模板视频超过 10 秒' }, { status: 422 })
        return HttpResponse.json(findMockBrandTemplate('ba000001-0000-4000-8000-000000000001'), {
          status: 201,
        })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await user.click(screen.getByRole('button', { name: '上传资源' }))
    const dialog = screen.getByRole('dialog', { name: '上传品牌资源' })
    await user.selectOptions(within(dialog).getByLabelText('类型'), 'outro')
    await user.upload(
      within(dialog).getByLabelText('资源文件'),
      new File(['video'], '新品.mp4', { type: 'video/mp4' }),
    )
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('模板视频超过 10 秒')
    expect(submitted).toEqual([
      { name: '新品', brand: null, kind: 'outro', uploadId: expect.any(String) },
    ])
    reject = false
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(signs).toBe(1)
    expect(submitted[1]).toEqual(submitted[0])
  })

  it('维护失败显式提示，列表保留原状态', async () => {
    server.use(
      http.patch('*/api/brand-templates/:id', () =>
        HttpResponse.json({ detail: '没有维护权限' }, { status: 403 }),
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    await user.click(within(card).getByRole('button', { name: '停用' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没有维护权限')
    expect(card).toBeVisible()
    expect(within(card).queryByText('已停用')).toBeNull()
  })
})

describe('品牌资源与字体预览', () => {
  it('按类型与品牌组合筛选，品牌选项保留其他资源的品牌', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: '示例字体' })
    await user.selectOptions(screen.getByRole('combobox', { name: '筛选品牌' }), '通用')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('article', { name: '示例字体' })).toBeVisible()
    expect(screen.getByRole('option', { name: '示例品牌' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: '筛选品牌' }), '示例品牌')
    await user.click(screen.getByRole('radio', { name: '片尾' }))
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('article', { name: '品牌片尾 · 竖版' })).toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: '显示已停用' }))
    expect(await screen.findByRole('article', { name: '旧版片尾' })).toBeVisible()
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
    const card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    let dialog = screen.getByRole('dialog', { name: '编辑品牌资源' })
    await user.clear(within(dialog).getByLabelText('品牌'))
    await user.type(within(dialog).getByLabelText('品牌'), ' 新品牌 ')
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
    expect(await within(card).findByText('新品牌')).toBeVisible()
    expect(patches[0]).toEqual({ name: '品牌片头 · 竖版', brand: '新品牌' })
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    dialog = screen.getByRole('dialog', { name: '编辑品牌资源' })
    await user.clear(within(dialog).getByLabelText('品牌'))
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(card).queryByText('新品牌')).toBeNull()
    expect(patches[1]).toEqual({ name: '品牌片头 · 竖版', brand: null })
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
    await user.click(screen.getByRole('button', { name: '上传资源' }))
    const dialog = screen.getByRole('dialog', { name: '上传品牌资源' })
    expect(within(dialog).getByLabelText('类型')).toHaveValue('font')
    await user.type(within(dialog).getByLabelText('品牌'), '秋日品牌')
    await user.upload(
      within(dialog).getByLabelText('资源文件'),
      new File(['font'], '新品.otf', { type: 'font/otf' }),
    )
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('资源登记失败')
    await user.click(within(dialog).getByRole('button', { name: '保存资源' }))
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
  })

  it.each(['width', 'height', 'durationMs', 'hasAudio'] as const)(
    '视频缺少 %s 仍可维护和预览，并明确不可合成',
    async (field) => {
      const template = findMockBrandTemplate('ba000001-0000-4000-8000-000000000001')
      server.use(
        http.get('*/api/brand-templates', () =>
          HttpResponse.json({ items: [{ ...template, [field]: null }] }),
        ),
      )
      const user = userEvent.setup()
      await renderWithProviders(<Harness />)
      const card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
      expect(within(card).getByText(/视频参数不完整，无法用于合成/)).toBeVisible()
      expect(within(card).getByRole('button', { name: '编辑' })).toBeEnabled()
      await user.click(within(card).getByRole('button', { name: '预览资源：品牌片头 · 竖版' }))
      expect(screen.getByRole('dialog', { name: '品牌片头 · 竖版' })).toBeVisible()
    },
  )

  it('实际字体加载完成之前显示加载状态，不展示替代字体预览', async () => {
    fonts.setMode('deferred')
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await user.click(await screen.findByRole('button', { name: '预览资源：示例字体' }))
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
    await screen.findByText('字体预览不可用')
    await user.click(screen.getByRole('button', { name: '预览资源：示例字体' }))
    const dialog = screen.getByRole('dialog', { name: '示例字体' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('字体加载失败')
    expect(within(dialog).queryByText('Made for your next adventure.')).toBeNull()
    fonts.setMode('immediate')
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByText('Made for your next adventure.')).toBeVisible()
    expect(fonts.installed.size).toBe(1)
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
    await user.click(await screen.findByRole('button', { name: '预览资源：示例字体' }))
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
