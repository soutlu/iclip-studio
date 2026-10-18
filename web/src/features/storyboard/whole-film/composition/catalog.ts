/**
 * 组件目录（`../catalog/catalog.json`）的结构。目录人工维护；组件文件由
 * `web/scripts/hyperframes-registry.mjs` 按同样的相对路径同步。
 */

/** 组件放到成片的哪里。 */
export type Placement = 'caption' | 'transition' | 'intro' | 'outro' | 'overlay'

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

/**
 * 转场接到切点上的方式。转场按组件原定时长 `duration` 播放；`cutAt` 是切点在转场里的位置（占时长的比例）。
 */
export type TransitionAttachment =
  /** 组件自己盖住画面，在 `cutAt` 处切到下一段。 */
  | { kind: 'overlay'; cutAt: number }
  /**
   * 组件只画中间层，前后两段的画面也要动：切点前前一段做 `out` 动画，切点后后一段做 `in` 动画
   * （组件头注释里的时间线写法，挂到这一个切点的两段上）。
   */
  | { kind: 'layers'; cutAt: number; out: LayerTween; in: LayerTween }

export interface LayerTween {
  from: Record<string, number>
  to: Record<string, number>
  ease: string
}

export interface CatalogItem {
  name: string
  kind: 'block' | 'component'
  title: string
  description: string
  category: string
  placement: Placement
  /** 合成文件，相对组件目录根。 */
  src: string
  /** 组件按固定尺寸设计时的尺寸；null 表示铺满所在位置。 */
  size: { width: number; height: number } | null
  /** 组件原定时长（秒）；没有固定时长时为 null。 */
  duration: number | null
  variables: CatalogVariable[]
  /** `../catalog/thumbnails/` 下的缩略图文件名。 */
  thumbnail: string | null
  /** 只有转场有。 */
  transition?: TransitionAttachment
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
