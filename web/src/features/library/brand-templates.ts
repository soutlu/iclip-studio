import { FONT_ACCEPT, MEDIA_VIDEO_ACCEPT } from '@/shared/api/media-upload'

export const BRAND_TEMPLATE_KINDS = [
  { value: 'font', label: '字体', media: 'font', accept: FONT_ACCEPT, fileHint: 'TTF / OTF' },
  {
    value: 'intro',
    label: '片头',
    media: 'video',
    accept: MEDIA_VIDEO_ACCEPT,
    fileHint: 'MP4 / MOV · 最长 10 秒',
  },
  {
    value: 'outro',
    label: '片尾',
    media: 'video',
    accept: MEDIA_VIDEO_ACCEPT,
    fileHint: 'MP4 / MOV · 最长 10 秒',
  },
] as const

export type BrandTemplateKind = (typeof BRAND_TEMPLATE_KINDS)[number]
export type BrandTemplateKindValue = BrandTemplateKind['value']

export const BRAND_TEMPLATE_KIND_VALUES = BRAND_TEMPLATE_KINDS.map((kind) => kind.value)

export const brandTemplateKindOf = (value: string): BrandTemplateKind | undefined =>
  BRAND_TEMPLATE_KINDS.find((kind) => kind.value === value)

export type BrandTemplateScope = {
  q: string
  kind: BrandTemplateKindValue | undefined
  brand: string | undefined
  includeDisabled: boolean
}
