/** 品牌模板演示记录与维护接口；权限、不可删除与停用语义同合同。 */
import { http, HttpResponse } from 'msw'
import type { BrandTemplateOut } from '@/shared/api/generated/types.gen'
import { zBrandTemplateCreateIn, zBrandTemplateUpdateIn } from '@/shared/api/generated/zod.gen'
import sampleWideUrl from '../fixtures/sample-video-wide.mp4?no-inline'
import sampleVideoUrl from '../fixtures/sample-video.mp4?no-inline'
import sampleEditedUrl from '../fixtures/sample-edited.mp4?no-inline'

const seedTemplates = (): BrandTemplateOut[] => [
  {
    id: 'ba000001-0000-4000-8000-000000000001',
    name: '品牌片头 · 竖版',
    position: 'intro',
    url: sampleVideoUrl,
    width: 180,
    height: 320,
    durationMs: 6000,
    hasAudio: true,
    createdAt: '2026-10-14T10:00:00Z',
    disabledAt: null,
  },
  {
    id: 'ba000001-0000-4000-8000-000000000002',
    name: '品牌片尾 · 竖版',
    position: 'outro',
    url: sampleEditedUrl,
    width: 180,
    height: 320,
    durationMs: 3000,
    hasAudio: false,
    createdAt: '2026-10-14T09:00:00Z',
    disabledAt: null,
  },
  {
    id: 'ba000001-0000-4000-8000-000000000003',
    name: '品牌片头 · 横版',
    position: 'intro',
    url: sampleWideUrl,
    width: 320,
    height: 180,
    durationMs: 6000,
    hasAudio: false,
    createdAt: '2026-10-14T08:00:00Z',
    disabledAt: null,
  },
  {
    id: 'ba000001-0000-4000-8000-000000000004',
    name: '旧版片尾',
    position: 'outro',
    url: sampleEditedUrl,
    width: 180,
    height: 320,
    durationMs: 3000,
    hasAudio: false,
    createdAt: '2026-10-14T07:00:00Z',
    disabledAt: '2026-10-14T11:00:00Z',
  },
]

let templates = seedTemplates()
export const resetMockBrandTemplates = () => {
  templates = seedTemplates()
}
export const findMockBrandTemplate = (id: string) => templates.find((item) => item.id === id)

export const brandTemplateHandlers = (permissions: () => readonly string[]) => {
  const denied = () => HttpResponse.json({ detail: '没有维护品牌模板的权限' }, { status: 403 })
  return [
    http.get('*/api/brand-templates', ({ request }) => {
      const query = new URL(request.url).searchParams
      if (!permissions().includes('generation:read')) return denied()
      const includeDisabled = query.get('includeDisabled') === 'true'
      if (includeDisabled && !permissions().includes('users:manage')) return denied()
      const position = query.get('position')
      return HttpResponse.json({
        items: templates.filter(
          (item) =>
            (includeDisabled || item.disabledAt === null) &&
            (position === null || item.position === position),
        ),
      })
    }),
    http.post('*/api/brand-templates', async ({ request }) => {
      if (!permissions().includes('users:manage')) return denied()
      const parsed = zBrandTemplateCreateIn.safeParse(await request.json())
      if (!parsed.success) return HttpResponse.json({ detail: '模板参数不正确' }, { status: 422 })
      const template: BrandTemplateOut = {
        id: crypto.randomUUID(),
        name: parsed.data.name.trim(),
        position: parsed.data.position,
        url: sampleVideoUrl,
        width: 180,
        height: 320,
        durationMs: 6000,
        hasAudio: true,
        createdAt: new Date().toISOString(),
        disabledAt: null,
      }
      templates.unshift(template)
      return HttpResponse.json(template, { status: 201 })
    }),
    http.patch('*/api/brand-templates/:id', async ({ params, request }) => {
      if (!permissions().includes('users:manage')) return denied()
      const template = findMockBrandTemplate(String(params['id']))
      if (template === undefined)
        return HttpResponse.json({ detail: '模板不存在' }, { status: 404 })
      const parsed = zBrandTemplateUpdateIn.safeParse(await request.json())
      if (!parsed.success || (parsed.data.name == null && parsed.data.disabled == null))
        return HttpResponse.json({ detail: '模板参数不正确' }, { status: 422 })
      if (parsed.data.name != null) template.name = parsed.data.name.trim()
      if (parsed.data.disabled != null)
        template.disabledAt = parsed.data.disabled
          ? (template.disabledAt ?? new Date().toISOString())
          : null
      return HttpResponse.json(template)
    }),
  ]
}
