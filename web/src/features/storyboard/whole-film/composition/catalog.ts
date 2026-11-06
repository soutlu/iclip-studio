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
}

export interface CatalogFont {
  css: string
  brand?: string
}

export interface ExcludedItem {
  name: string
  title: string
  reason: string
}

export interface ComponentCatalog {
  version: string
  runtime: { hyperframes: string; gsap: string; cjkFont: string }
  fonts: Record<string, CatalogFont>
  categories: { id: string; label: string }[]
  items: CatalogItem[]
  excluded: ExcludedItem[]
}
