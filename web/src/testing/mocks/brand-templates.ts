/** 品牌资源演示记录；字体直传独立于生成记录，启停与类型校验同合同。 */
import { http, HttpResponse } from 'msw'
import type { BrandTemplateOut } from '@/shared/api/generated/types.gen'
import {
  zBrandFontConfirmIn,
  zBrandFontInfoOut,
  zBrandFontSignIn,
  zBrandTemplateCreateIn,
  zBrandTemplateUpdateIn,
} from '@/shared/api/generated/zod.gen'
import sampleWideUrl from '../fixtures/sample-video-wide.mp4?no-inline'
import sampleVideoUrl from '../fixtures/sample-video.mp4?no-inline'
import sampleEditedUrl from '../fixtures/sample-edited.mp4?no-inline'
import sampleFontUrl from '../fixtures/sample-font.otf?no-inline'
import fontInfo from '../fixtures/sample-font-info.json'

export const mockBrandFontInfo = zBrandFontInfoOut.parse(fontInfo)
const seedTemplates = (): BrandTemplateOut[] => [
  {
    id: 'ba000001-0000-4000-8000-000000000001',
    name: '品牌片头 · 竖版',
    kind: 'intro',
    brand: '示例品牌',
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
    kind: 'outro',
    brand: '示例品牌',
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
    kind: 'intro',
    brand: null,
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
    kind: 'outro',
    brand: '示例品牌',
    url: sampleEditedUrl,
    width: 180,
    height: 320,
    durationMs: 3000,
    hasAudio: false,
    createdAt: '2026-10-14T07:00:00Z',
    disabledAt: '2026-10-14T11:00:00Z',
  },
  {
    id: 'ba000001-0000-4000-8000-000000000005',
    name: '示例字体',
    kind: 'font',
    brand: '通用',
    url: sampleFontUrl,
    width: null,
    height: null,
    durationMs: null,
    hasAudio: null,
    createdAt: '2026-10-14T06:00:00Z',
    disabledAt: null,
  },
]

let templates = seedTemplates()
const fontUploads = new Map<string, { contentType: string; body?: ArrayBuffer }>()
const fontUrlOf = (id: string) => `http://localhost/mock-font-oss/${id}`
export const resetMockBrandTemplates = () => {
  templates = seedTemplates()
  fontUploads.clear()
}
export const findMockBrandTemplate = (id: string) => templates.find((item) => item.id === id)

export const brandTemplateHandlers = (permissions: () => readonly string[]) => {
  const denied = () => HttpResponse.json({ detail: '没有维护品牌资源的权限' }, { status: 403 })
  const canUploadFont = () =>
    permissions().includes('users:manage') && permissions().includes('uploads:write')
  return [
    http.get('*/api/brand-templates', ({ request }) => {
      const query = new URL(request.url).searchParams
      if (!permissions().includes('generation:read')) return denied()
      const includeDisabled = query.get('includeDisabled') === 'true'
      if (includeDisabled && !permissions().includes('users:manage')) return denied()
      const kind = query.get('kind'),
        brand = query.get('brand')
      return HttpResponse.json({
        items: templates.filter(
          (item) =>
            (includeDisabled || item.disabledAt === null) &&
            (kind === null || item.kind === kind) &&
            (brand === null || item.brand === brand),
        ),
      })
    }),
    http.get('*/api/brand-templates/:id/font-info', ({ params }) => {
      if (!permissions().includes('generation:read')) return denied()
      const font = findMockBrandTemplate(String(params['id']))
      if (font === undefined) return HttpResponse.json({ detail: '字体不存在' }, { status: 404 })
      if (font.kind !== 'font')
        return HttpResponse.json({ detail: '这个资源不是字体' }, { status: 422 })
      return HttpResponse.json(mockBrandFontInfo)
    }),
    http.post('*/api/brand-templates/fonts/sign', async ({ request }) => {
      if (!canUploadFont()) return denied()
      const parsed = zBrandFontSignIn.safeParse(await request.json())
      if (!parsed.success) return HttpResponse.json({ detail: '字体类型不正确' }, { status: 422 })
      const uploadId = crypto.randomUUID()
      fontUploads.set(uploadId, { contentType: parsed.data.contentType })
      return HttpResponse.json({
        uploadId,
        upload: {
          url: fontUrlOf(uploadId),
          method: 'PUT',
          headers: { 'Content-Type': parsed.data.contentType },
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      })
    }),
    http.put('*/mock-font-oss/:id', async ({ params, request }) => {
      const file = fontUploads.get(String(params['id']))
      if (file === undefined) return new HttpResponse(null, { status: 403 })
      file.body = await request.arrayBuffer()
      return new HttpResponse(null, { status: 200 })
    }),
    http.get('*/mock-font-oss/:id', ({ params }) => {
      const file = fontUploads.get(String(params['id']))
      return file?.body === undefined
        ? new HttpResponse(null, { status: 404 })
        : new HttpResponse(file.body, {
            headers: { 'Content-Type': file.contentType, 'Access-Control-Allow-Origin': '*' },
          })
    }),
    http.post('*/api/brand-templates/fonts/:id/confirm', async ({ params, request }) => {
      if (!canUploadFont()) return denied()
      const parsed = zBrandFontConfirmIn.safeParse(await request.json())
      if (!parsed.success) return HttpResponse.json({ detail: '字体参数不正确' }, { status: 422 })
      const id = String(params['id']),
        recorded = findMockBrandTemplate(id)
      if (recorded !== undefined) return HttpResponse.json(recorded, { status: 201 })
      const upload = fontUploads.get(id)
      if (upload?.body === undefined)
        return HttpResponse.json({ detail: '这个文件还没传上来' }, { status: 409 })
      const created: BrandTemplateOut = {
        id,
        kind: 'font',
        brand: parsed.data.brand ?? null,
        name: parsed.data.name.trim(),
        url: fontUrlOf(id),
        width: null,
        height: null,
        durationMs: null,
        hasAudio: null,
        createdAt: new Date().toISOString(),
        disabledAt: null,
      }
      templates.unshift(created)
      return HttpResponse.json(created, { status: 201 })
    }),
    http.post('*/api/brand-templates', async ({ request }) => {
      if (!permissions().includes('users:manage')) return denied()
      const parsed = zBrandTemplateCreateIn.safeParse(await request.json())
      if (!parsed.success) return HttpResponse.json({ detail: '模板参数不正确' }, { status: 422 })
      const template: BrandTemplateOut = {
        id: crypto.randomUUID(),
        name: parsed.data.name.trim(),
        kind: parsed.data.kind,
        brand: parsed.data.brand ?? null,
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
      if (
        !parsed.success ||
        (parsed.data.name == null && parsed.data.disabled == null && !('brand' in parsed.data))
      )
        return HttpResponse.json({ detail: '模板参数不正确' }, { status: 422 })
      if (parsed.data.name != null) template.name = parsed.data.name.trim()
      if ('brand' in parsed.data) template.brand = parsed.data.brand ?? null
      if (parsed.data.disabled != null)
        template.disabledAt = parsed.data.disabled
          ? (template.disabledAt ?? new Date().toISOString())
          : null
      return HttpResponse.json(template)
    }),
  ]
}
