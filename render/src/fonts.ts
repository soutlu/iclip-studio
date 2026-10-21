/**
 * 让 HyperFrames 看见合成页引用的字体 CSS（组件库 vendor/fonts/ 下）里定义的字体。
 *
 * HyperFrames 渲染前会给页面里用到、却找不到 @font-face 的字体另补一套字形（自带的或 Google Fonts 的），
 * 它只认页面里内联的 @font-face，看不到 `<link>` 引用的样式表；补上的字形与编辑器预览用的不同。
 * 这里在每个字体 CSS 的 `<link>` 前内联它里面每个字体的第一条 @font-face：HyperFrames 因此不再另补，
 * 字形仍全部来自 `<link>` 的样式表，与预览一致。不整份内联：整份有几百 KB，HyperFrames 编译时会反复解析
 * 整页，渲染服务的事件循环会被占住好几秒。样式表里的 url() 相对样式表自己，内联后改成相对合成页。
 */
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

const FONT_LINK = /<link rel="stylesheet" href="(vendor\/fonts\/[^"]+\.css)">/g
const FONT_FACE = /@font-face\s*\{[^}]*\}/g
const FAMILY = /font-family\s*:\s*([^;}]+)/
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

/** 样式表里相对它自己的 url() 改成相对合成页（组件目录根）。 */
function rebase(css: string, href: string): string {
  return css.replace(CSS_URL, (whole, _quote: string, reference: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(reference)) return whole
    return `url(${posix.normalize(posix.join(posix.dirname(href), reference))})`
  })
}

/** 每个字体的第一条 @font-face，按出现先后。 */
function firstFacePerFamily(css: string): string[] {
  const seen = new Set<string>()
  const rules: string[] = []
  for (const [rule] of css.matchAll(FONT_FACE)) {
    const family = FAMILY.exec(rule)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase()
    if (!family || seen.has(family)) continue
    seen.add(family)
    rules.push(rule)
  }
  return rules
}

/** 组件库里缺了合成页引用的字体 CSS 时抛出：组件库与组件目录对不上。 */
export async function declareLinkedFonts(html: string, registryDir: string): Promise<string> {
  const hrefs = [...new Set([...html.matchAll(FONT_LINK)].map((match) => match[1] ?? ''))]
  const declarations = new Map<string, string>()
  for (const href of hrefs) {
    let css: string
    try {
      css = await readFile(join(registryDir, href), 'utf8')
    } catch (error) {
      throw new Error(`组件库缺少字体 CSS：${href}`, { cause: error })
    }
    const rules = firstFacePerFamily(css).map((rule) => rebase(rule, href))
    declarations.set(href, rules.length > 0 ? `<style>${rules.join('\n')}</style>\n` : '')
  }
  return html.replace(FONT_LINK, (link, href: string) => `${declarations.get(href) ?? ''}${link}`)
}
