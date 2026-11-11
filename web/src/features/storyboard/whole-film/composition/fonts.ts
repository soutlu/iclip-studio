import type { CjkFont, ComponentCatalog } from './catalog'

type Range = readonly [from: number, to: number]

const CJK_BLOCKS: readonly Range[] = [
  [0x2e80, 0x2fdf],
  [0x3000, 0x30ff],
  [0x3100, 0x31ff],
  [0x3200, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe1f],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x20000, 0x3134f],
]
const isCjk = (code: number) => CJK_BLOCKS.some(([from, to]) => from <= code && code <= to)

// 组件脚本生成的数字和标点不在任何文件里，所以西文基本字符总是算作用到
const ALWAYS: Range = [0x20, 0x7e]

function parseRanges(value: string): Range[] {
  return value.split(',').map((part) => {
    const [from = '', to = from] = part.trim().replace(/^U\+/i, '').split('-')
    return [parseInt(from, 16), parseInt(to, 16)]
  })
}

/** 升序的码位写成 `unicode-range`，连着的并成一段。 */
function unicodeRange(codes: readonly number[]): string {
  const parts: string[] = []
  const hex = (code: number) => code.toString(16)
  let from: number | undefined
  let to = 0
  const close = () => {
    if (from !== undefined) parts.push(from === to ? `U+${hex(from)}` : `U+${hex(from)}-${hex(to)}`)
  }
  for (const code of codes) {
    if (from !== undefined && code === to + 1) {
      to = code
      continue
    }
    close()
    from = to = code
  }
  close()
  return parts.join(',')
}

// 每次改动都会重拼成片，分片表只解析一次
const holdersOfCode = new WeakMap<CjkFont, Map<number, number[]>>()

/** 每个码位落在哪些分片里，按声明顺序。 */
function sliceIndex(cjk: CjkFont): Map<number, number[]> {
  const cached = holdersOfCode.get(cjk)
  if (cached) return cached
  const index = new Map<number, number[]>()
  cjk.slices.forEach(({ range }, at) => {
    for (const [from, to] of parseRanges(range)) {
      for (let code = from; code <= to; code++) {
        const holders = index.get(code)
        if (holders) holders.push(at)
        else index.set(code, [at])
      }
    }
  })
  holdersOfCode.set(cjk, index)
  return index
}

const fontFace = (family: string, style: string, weight: string, file: string, range: string) =>
  `@font-face{font-family:'${family}';font-style:${style};font-display:block;font-weight:${weight};` +
  `src:url(${file}) format('woff2');unicode-range:${range}}`

/**
 * 成片要声明的中文字体规则：只带 `text` 用到的分片，每条规则的范围只写用到的字。
 * `families` 里带中文孪生描述的字体族，各按描述再出一组指向同样分片的规则，范围只留中日韩区块里的字。
 */
export function cjkFontFaces(
  catalog: ComponentCatalog,
  text: string,
  families: readonly string[],
): string {
  const index = sliceIndex(catalog.cjk)
  const codes = new Set<number>()
  for (let code = ALWAYS[0]; code <= ALWAYS[1]; code++) codes.add(code)
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code > ALWAYS[1]) codes.add(code)
  }
  // 分片之间有重叠：靠后声明的规则先生效，它的文件里没有这个字形时浏览器才退到靠前的，所以含这个字的
  // 分片都要带上。西文基本字符例外：最后的 latin 分片里都有，前面那些分片不用为了它们带上。
  const codesIn = new Map<number, number[]>()
  for (const code of [...codes].sort((a, b) => a - b)) {
    const holders = index.get(code) ?? []
    for (const at of code <= ALWAYS[1] ? holders.slice(-1) : holders) {
      const held = codesIn.get(at)
      if (held) held.push(code)
      else codesIn.set(at, [code])
    }
  }
  const used = catalog.cjk.slices.flatMap(({ files }, at) => {
    const held = codesIn.get(at)
    return held
      ? [{ files, range: unicodeRange(held), cjkRange: unicodeRange(held.filter(isCjk)) }]
      : []
  })

  const weights = [...new Set(used.flatMap((slice) => Object.keys(slice.files)))].sort(
    (a, b) => Number(a) - Number(b),
  )
  const rules: string[] = []
  for (const weight of weights) {
    for (const { range, files } of used) {
      const file = files[weight]
      if (file !== undefined)
        rules.push(fontFace(catalog.cjk.family, 'normal', weight, file, range))
    }
  }
  for (const family of families) {
    for (const { weight, style } of catalog.fonts[family]?.cjk ?? []) {
      const glyphs = Number.parseInt(weight, 10) < 550 ? '400' : '700'
      for (const { cjkRange, files } of used) {
        const file = files[glyphs]
        if (cjkRange !== '' && file !== undefined)
          rules.push(fontFace(family, style, weight, file, cjkRange))
      }
    }
  }
  return rules.join('\n')
}
