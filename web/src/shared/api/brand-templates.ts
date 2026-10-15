/** 资料库与整片编辑器共用的品牌资源。参数与响应以生成合同为准。 */
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, UserFacingError } from './client'
import type {
  BrandFontConfirmIn,
  BrandTemplateCreateIn,
  BrandTemplateUpdateIn,
} from './generated/types.gen'
import {
  zBrandFontInfoOut,
  zBrandFontUploadTicketOut,
  zBrandTemplateOut,
  zBrandTemplatesOut,
} from './generated/zod.gen'
import { putToStorage } from './media-upload'

export type BrandTemplate = z.output<typeof zBrandTemplateOut>
export type BrandFontInfo = z.output<typeof zBrandFontInfoOut>
type TemplateScope = { kind?: string; brand?: string; includeDisabled?: boolean }

export const brandTemplateQueryKeys = {
  all: ['brand-templates'] as const,
  list: (scope: TemplateScope) => ['brand-templates', scope] as const,
}

export const useBrandTemplates = (scope: TemplateScope = {}) =>
  useQuery({
    queryKey: brandTemplateQueryKeys.list(scope),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams()
      if (scope.kind !== undefined) query.set('kind', scope.kind)
      if (scope.brand !== undefined) query.set('brand', scope.brand)
      if (scope.includeDisabled === true) query.set('includeDisabled', 'true')
      return apiFetch(
        `/brand-templates${query.size === 0 ? '' : `?${query.toString()}`}`,
        zBrandTemplatesOut,
        {
          signal,
          fallbackErrorMessage: '读取品牌模板失败',
        },
      )
    },
  })

export const createBrandTemplate = (body: BrandTemplateCreateIn): Promise<BrandTemplate> =>
  apiFetch('/brand-templates', zBrandTemplateOut, {
    method: 'POST',
    body,
    fallbackErrorMessage: '创建品牌模板失败',
  })

export const updateBrandTemplate = (
  id: string,
  body: BrandTemplateUpdateIn,
): Promise<BrandTemplate> =>
  apiFetch(`/brand-templates/${encodeURIComponent(id)}`, zBrandTemplateOut, {
    method: 'PATCH',
    body,
    fallbackErrorMessage: '更新品牌模板失败',
  })

export const getBrandFontInfo = (id: string, signal?: AbortSignal): Promise<BrandFontInfo> =>
  apiFetch(`/brand-templates/${encodeURIComponent(id)}/font-info`, zBrandFontInfoOut, {
    ...(signal === undefined ? {} : { signal }),
    fallbackErrorMessage: '读取字体信息失败',
  })

export const BRAND_FONT_ACCEPT = '.ttf,.otf'

/** 字体直传与登记分开；登记失败时重用 uploadId，不重复上传同一文件。 */
export const uploadBrandFontFile = async (
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<string> => {
  const extension = /\.([^./]+)$/.exec(file.name)?.[1]?.toLowerCase()
  if (extension !== 'ttf' && extension !== 'otf')
    throw new UserFacingError('字体格式不受支持，请选择 TTF 或 OTF 文件')
  if (file.size > 32 * 1024 * 1024) throw new UserFacingError('字体文件不能超过 32 MiB')
  const ticket = await apiFetch('/brand-templates/fonts/sign', zBrandFontUploadTicketOut, {
    method: 'POST',
    body: { contentType: extension === 'ttf' ? 'font/ttf' : 'font/otf' },
    fallbackErrorMessage: '上传字体失败',
  })
  await putToStorage(ticket.upload, file, onProgress)
  return ticket.uploadId
}

export const confirmBrandFont = (
  uploadId: string,
  body: BrandFontConfirmIn,
): Promise<BrandTemplate> =>
  apiFetch(`/brand-templates/fonts/${encodeURIComponent(uploadId)}/confirm`, zBrandTemplateOut, {
    method: 'POST',
    body,
    fallbackErrorMessage: '保存字体失败',
  })
