/** 资料库与整片编辑器共用的品牌片头片尾记录。参数与响应以生成合同为准。 */
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from './client'
import type { BrandTemplateCreateIn, BrandTemplateUpdateIn } from './generated/types.gen'
import { zBrandTemplateOut, zBrandTemplatesOut } from './generated/zod.gen'

export type BrandTemplate = z.output<typeof zBrandTemplateOut>
type TemplateScope = { position?: 'intro' | 'outro'; includeDisabled?: boolean }

export const brandTemplateQueryKeys = {
  all: ['brand-templates'] as const,
  list: (scope: TemplateScope) => ['brand-templates', scope] as const,
}

export const useBrandTemplates = (scope: TemplateScope = {}) =>
  useQuery({
    queryKey: brandTemplateQueryKeys.list(scope),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams()
      if (scope.position !== undefined) query.set('position', scope.position)
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
