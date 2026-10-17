import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from './client'
import type {
  BrandFontConfirmIn,
  BrandProfileIn,
  BrandTemplateUpdateIn,
} from './generated/types.gen'
import {
  zBrandFontInfoOut,
  zBrandProfileOut,
  zBrandProfilesOut,
  zBrandTemplateOut,
  zBrandTemplatesOut,
  type zListBrandTemplatesBrandTemplatesGetQuery,
  zUploadTicketOut,
} from './generated/zod.gen'
import { uploadFontFile } from './media-upload'

export type BrandTemplate = z.output<typeof zBrandTemplateOut>
export type BrandFontInfo = z.output<typeof zBrandFontInfoOut>
export type BrandProfile = z.output<typeof zBrandProfileOut>
type TemplateScope = Pick<
  z.input<typeof zListBrandTemplatesBrandTemplatesGetQuery>,
  'includeDisabled'
>

export const brandTemplateQueryKeys = {
  all: ['brand-templates'] as const,
  list: (scope: TemplateScope) => ['brand-templates', scope] as const,
  brands: ['brand-templates', 'brands'] as const,
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

/** 全部品牌连同标语与强调色，按品牌名排；没设过的两项为 null。 */
export const useBrandProfiles = () =>
  useQuery({
    queryKey: brandTemplateQueryKeys.brands,
    queryFn: ({ signal }) =>
      apiFetch('/brand-templates/brands', zBrandProfilesOut, {
        signal,
        fallbackErrorMessage: '读取品牌失败',
      }),
  })

/** 整份写入一个品牌的标语与强调色，null 清空那一项。 */
export const saveBrandProfile = (brand: string, body: BrandProfileIn): Promise<BrandProfile> =>
  apiFetch(`/brand-templates/brands/${encodeURIComponent(brand)}`, zBrandProfileOut, {
    method: 'PUT',
    body,
    fallbackErrorMessage: '保存品牌设置失败',
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
