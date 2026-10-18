import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from './client'
import type { BrandFontConfirmIn, BrandTemplateUpdateIn } from './generated/types.gen'
import {
  zBrandFontInfoOut,
  zBrandTemplateOut,
  zBrandTemplatesOut,
  type zListBrandTemplatesBrandTemplatesGetQuery,
  zUploadTicketOut,
} from './generated/zod.gen'
import { uploadFontFile } from './media-upload'

export type BrandTemplate = z.output<typeof zBrandTemplateOut>
export type BrandFontInfo = z.output<typeof zBrandFontInfoOut>
type TemplateScope = Pick<
  z.input<typeof zListBrandTemplatesBrandTemplatesGetQuery>,
  'includeDisabled'
>

export const brandTemplateQueryKeys = {
  all: ['brand-templates'] as const,
  list: (scope: TemplateScope) => ['brand-templates', scope] as const,
}

export const useBrandTemplates = (scope: TemplateScope = {}) =>
  useQuery({
    queryKey: brandTemplateQueryKeys.list(scope),
    queryFn: ({ signal }) =>
      apiFetch(
        `/brand-templates${scope.includeDisabled === true ? '?includeDisabled=true' : ''}`,
        zBrandTemplatesOut,
        {
          signal,
          fallbackErrorMessage: '读取品牌模板失败',
        },
      ),
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

export const uploadBrandFontFile = (
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<string> =>
  uploadFontFile(
    file,
    (contentType) =>
      apiFetch('/brand-templates/fonts/sign', zUploadTicketOut, {
        method: 'POST',
        body: { contentType },
        fallbackErrorMessage: '上传字体失败',
      }),
    onProgress,
  )

export const confirmBrandFont = (
  uploadId: string,
  body: BrandFontConfirmIn,
): Promise<BrandTemplate> =>
  apiFetch(`/brand-templates/fonts/${encodeURIComponent(uploadId)}/confirm`, zBrandTemplateOut, {
    method: 'POST',
    body,
    fallbackErrorMessage: '保存字体失败',
  })
