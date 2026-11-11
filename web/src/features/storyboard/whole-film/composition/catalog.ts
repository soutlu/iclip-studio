export type VariableValue = string | number | boolean

export interface CatalogVariable {
  id: string
  type: 'string' | 'number' | 'color' | 'boolean' | 'enum' | 'font' | 'image'
  label: string
  default: VariableValue
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  unit?: string
}

export interface CatalogItem {
  name: string
  kind: 'block' | 'component'
  title: string
  description: string
  category: string
  placement: 'caption' | null
  brand?: string
  src: string
  size: { width: number; height: number } | null
  duration: number | null
  variables: CatalogVariable[]
  thumbnail: string | null
  fonts: string[]
  /** 组件文件里出现的非 ASCII 字符，成片按它声明中文字体分片。 */
  chars: string
}

export interface CatalogFont {
  css: string
  brand?: string
  /** 这个字体族要带的中文孪生规则，各用哪种字重和字形。 */
  cjk?: { weight: string; style: string }[]
}

export interface CjkFont {
  family: string
  /** 一个分片一段 `unicode-range`，`files` 是字重到字形文件的路径。 */
  slices: { range: string; files: Record<string, string> }[]
}

export interface ExcludedItem {
  name: string
  title: string
  reason: string
}

export interface ComponentCatalog {
  version: string
  runtime: { hyperframes: string; gsap: string }
  cjk: CjkFont
  fonts: Record<string, CatalogFont>
  categories: { id: string; label: string }[]
  items: CatalogItem[]
  excluded: ExcludedItem[]
}
