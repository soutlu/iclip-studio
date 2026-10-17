export type BrandTemplateScope = {
  q: string
  brand: string | undefined
  includeDisabled: boolean
}

const ACCENT_COLOR = /^#[0-9a-f]{6}$/i

/** 强调色要写成 #RRGGBB，大小写不限。 */
export const isAccentColor = (value: string): boolean => ACCENT_COLOR.test(value)
