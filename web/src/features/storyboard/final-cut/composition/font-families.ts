/**
 * 渲染器判断字体用的几个函数（`@hyperframes/core/fonts/embed` 的同名导出），由调用方传入：组件库组装脚本和
 * 渲染服务各自装了一份引擎，CI 里只装其中一边的依赖，这个文件直接导入引擎在另一边解析不到。
 */
export interface FontEngine {
  readonly GENERIC_FAMILIES: ReadonlySet<string>
  normalizeSystemFontPrimaryFamilies(html: string): string
  collectFontFamilyCustomProperties(html: string): ReadonlyMap<string, string>
  iterateFontFamilyDeclarations(html: string): Iterable<{ declaration: string }>
  resolveFontFamilyDeclarationFamilies(
    declaration: string,
    customProperties: ReadonlyMap<string, string>,
  ): readonly string[]
}

export interface FontFaceDescriptor {
  family: string
  weight: string
  style: string
}

const KEYWORD_WEIGHTS: Readonly<Record<string, string>> = { normal: '400', bold: '700' }

const cssValue = (block: string, property: string) =>
  new RegExp(`${property}\\s*:\\s*([^;}]+)`)
    .exec(block)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()

/** 文本里每条 @font-face 的字体名、字重与字形：normal/bold 换成数字，区间原样，缺省 400 normal；没写字体名的不算。 */
export function fontFaceDescriptors(text: string): FontFaceDescriptor[] {
  const result: FontFaceDescriptor[] = []
  for (const [, block = ''] of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = cssValue(block, 'font-family')
    if (!family) continue
    const weight = cssValue(block, 'font-weight') ?? '400'
    result.push({
      family,
      weight: KEYWORD_WEIGHTS[weight] ?? weight,
      style: cssValue(block, 'font-style') ?? 'normal',
    })
  }
  return result
}

const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])
const TEMPLATE_TAG = /<\/?template\b[^>]*>/gi

/**
 * 渲染器编译工程时要自己去找的字体名：网页里 font-family 写到的每个名字（含后备字体、var() 的缺省值，
 * 以及渲染器给首选是通用字体族的声明补上的 Inter），除去通用字体族、网页里自带 @font-face 的和 `declared`。
 * 渲染器对这些名字按内置别名表取内置字形，再去 Google Fonts 补字重；不在别名表里的直接去 Google Fonts 取。
 * 名字照网页里的写法，不分大小写去重。
 *
 * @param html 主文件或组件文件
 * @param declared 网页外已经有 @font-face 的字体名
 * @param engine 渲染器判断字体用的函数
 */
export function undeclaredFontFamilies(
  html: string,
  declared: Iterable<string>,
  engine: FontEngine,
): string[] {
  // 渲染时 <template> 里的内容并进主文件，按普通内容读
  const page = engine.normalizeSystemFontPrimaryFamilies(html.replace(TEMPLATE_TAG, ''))
  const known = new Set(
    [...declared, ...fontFaceDescriptors(page).map((face) => face.family)].map((family) =>
      family.toLowerCase(),
    ),
  )
  const properties = engine.collectFontFamilyCustomProperties(page)
  const result = new Map<string, string>()
  for (const { declaration } of engine.iterateFontFamilyDeclarations(page)) {
    for (const family of engine.resolveFontFamilyDeclarationFamilies(declaration, properties)) {
      const key = family.toLowerCase()
      if (known.has(key) || engine.GENERIC_FAMILIES.has(key) || CSS_WIDE_KEYWORDS.has(key)) continue
      if (key.startsWith('var(') || result.has(key)) continue
      result.set(key, family)
    }
  }
  return [...result.values()]
}
