import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

const FONT_LINK = /<link rel="stylesheet" href="(vendor\/fonts\/[^"]+\.css)">/g
const FONT_FACE = /@font-face\s*\{[^}]*\}/g
const FAMILY = /font-family\s*:\s*([^;}]+)/
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

function rebase(css: string, href: string): string {
  return css.replace(CSS_URL, (whole, _quote: string, reference: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(reference)) return whole
    return `url(${posix.normalize(posix.join(posix.dirname(href), reference))})`
  })
}

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
