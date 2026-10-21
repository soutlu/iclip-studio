/**
 * 组件目录（`../catalog/catalog.json`）的结构。目录人工维护；组件文件由
 * `web/scripts/hyperframes-registry.mjs` 按同样的相对路径同步。
 */

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
  /** 点卡片时的默认去处：block 插进画面轨，component 放到特效轨；拖放时看落在哪条轨。 */
  kind: 'block' | 'component'
  title: string
  description: string
  category: string
  /** `caption` 是字幕样式，只能换掉全部字幕的样式；其余组件为 null，放在哪条轨都行。 */
  placement: 'caption' | null
  /** 品牌组件所属的品牌，只给组件栏分栏用；放置与合成不看它。 */
  brand?: string
  /** 合成文件，相对组件目录根。 */
  src: string
  /** 组件按固定尺寸设计时的尺寸；null 表示铺满所在位置。 */
  size: { width: number; height: number } | null
  /** 组件原定时长（秒）；没有固定时长时为 null。 */
  duration: number | null
  variables: CatalogVariable[]
  /** `../catalog/thumbnails/` 下的缩略图文件名。 */
  thumbnail: string | null
  /** 组件用到的网页字体，合成页给它们补上中文字形（见 {@link ComponentCatalog.fonts}）。 */
  fonts: string[]
}

export interface ExcludedItem {
  name: string
  title: string
  reason: string
}

export interface ComponentCatalog {
  /** HyperFrames 版本，也是组件目录在站点上的目录名。 */
  version: string
  /**
   * 合成页要加载的运行时脚本与中文字体 CSS，相对组件目录根。中文字体是合成页的默认字体，
   * 组件没写字体或字体变量未定义时也用它，预览与导出一致。
   */
  runtime: { hyperframes: string; gsap: string; cjkFont: string }
  /**
   * 网页字体 → 它整套字形的 CSS（相对组件目录根）：组件库里请求过的全部西文字重，加上同名、只覆盖
   * 中日韩码位、字形取 Noto Sans SC 的中文字形。只写字体名不引用字体文件的组件也能拿到这个字体，中文
   * 不再落到各平台各不相同的系统字体；渲染服务把它内联进合成页，HyperFrames 就不再另补同名字体。
   */
  fonts: Record<string, string>
  categories: { id: string; label: string }[]
  items: CatalogItem[]
  excluded: ExcludedItem[]
}
