import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { brandTemplateHandlers, findMockBrandTemplate } from '@/testing/mocks/brand-templates'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { BrandTemplatesRoute, type BrandTemplateScope } from './brand-templates-route'

function Harness({
  canManage = true,
  canUpload = true,
}: {
  canManage?: boolean
  canUpload?: boolean
}) {
  const [scope, setScope] = useState<BrandTemplateScope>({
    q: '',
    position: undefined,
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

beforeEach(() => server.use(...brandTemplateHandlers(() => ['generation:read', 'users:manage'])))

describe('BrandTemplatesRoute', () => {
  it('没有上传权限的治理者仍可维护已有模板，上传入口不出现', async () => {
    await renderWithProviders(<Harness canUpload={false} />)
    const card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    expect(screen.queryByRole('button', { name: '上传模板' })).toBeNull()
    expect(within(card).getByRole('button', { name: '改名' })).toBeVisible()
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
    expect(screen.queryByRole('button', { name: '上传模板' })).toBeNull()
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '显示已停用' })).toBeNull()
    expect(queries.every((query) => !query.has('includeDisabled'))).toBe(true)
    await user.click(screen.getByRole('button', { name: '预览模板：品牌片头 · 竖版' }))
    expect(screen.getByRole('dialog', { name: '品牌片头 · 竖版' })).toBeVisible()
  })

  it('治理者改名、停用与恢复，更新后列表同步', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    let card = await screen.findByRole('article', { name: '品牌片头 · 竖版' })
    await user.click(within(card).getByRole('button', { name: '改名' }))
    const dialog = screen.getByRole('dialog', { name: '修改模板名称' })
    await user.clear(within(dialog).getByLabelText('模板名称'))
    await user.type(within(dialog).getByLabelText('模板名称'), '新品片头')
    await user.click(within(dialog).getByRole('button', { name: '保存模板' }))
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
    await user.click(screen.getByRole('button', { name: '上传模板' }))
    const dialog = screen.getByRole('dialog', { name: '上传品牌模板' })
    await user.upload(
      within(dialog).getByLabelText('模板视频'),
      new File(['video'], '新品.mp4', { type: 'video/mp4' }),
    )
    await user.selectOptions(within(dialog).getByLabelText('使用位置'), 'outro')
    await user.click(within(dialog).getByRole('button', { name: '保存模板' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('模板视频超过 10 秒')
    expect(submitted).toEqual([{ name: '新品', position: 'outro', uploadId: expect.any(String) }])
    reject = false
    await user.click(within(dialog).getByRole('button', { name: '保存模板' }))
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
