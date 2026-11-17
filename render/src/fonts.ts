import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import * as fontEngine from '@hyperframes/core/fonts/embed'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import {
  fontFaceDescriptors,
  undeclaredFontFamilies,
} from '../../web/src/features/storyboard/final-cut/composition/font-families'
import { elementsOf, MAIN_FILE, type ProjectFile } from './project'

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

const REMOTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

const attributeOf = (element: DefaultTreeAdapterTypes.Element, name: string) =>
  element.attrs.find((attr) => attr.name === name)?.value

/**
 * 网页 `page`（相对工程根）里 `<link rel="stylesheet">` 的 `href` 指的工程里的样式表；指到工程外、远程地址
 * 或工程里没有的文件时是 undefined。和渲染器一样先按网页所在目录找，找不到再按工程根找。
 */
function stylesheetIn(project: string, page: string, href: string): string | undefined {
  if (href === '' || REMOTE.test(href)) return undefined
  for (const candidate of [posix.join(posix.dirname(page), href), href.replace(/^\/+/, '')]) {
    const path = posix.normalize(candidate)
    if (path === '..' || path.startsWith('../')) continue
    if (existsSync(join(project, path))) return join(project, path)
  }
  return undefined
}

/**
 * 写进 `project` 目录的工程里，渲染器编译时要自己去找的字体名（判断方式见 `undeclaredFontFamilies`）。查主文件和
 * 它经 `data-composition-src` 一层层挂载的文件：渲染时这些网页并成一页，所以任何一个网页里的 @font-face 和
 * 它链接的工程内样式表里的 @font-face 对所有网页都算声明过。名字不分大小写去重。
 *
 * @param project 工程目录，公共目录已经拷成里面的 `vendor`
 * @param files 写进去的工程文件
 */
export async function undeclaredProjectFonts(
  project: string,
  files: readonly ProjectFile[],
): Promise<string[]> {
  const contents = new Map(files.map((file) => [file.path, file.content]))
  const pages = contents.has(MAIN_FILE) ? [MAIN_FILE] : []
  const declared: string[] = []
  // 边查边把挂载的文件接到 pages 后面
  for (const page of pages) {
    const html = contents.get(page) ?? ''
    declared.push(...fontFaceDescriptors(html).map((face) => face.family))
    for (const element of elementsOf(parse(html))) {
      const src = attributeOf(element, 'data-composition-src')?.trim()
      const mounted = src === undefined ? undefined : posix.normalize(src)
      if (mounted !== undefined && contents.has(mounted) && !pages.includes(mounted))
        pages.push(mounted)
      const rel = attributeOf(element, 'rel')?.toLowerCase().split(/\s+/) ?? []
      if (element.tagName !== 'link' || !rel.includes('stylesheet')) continue
      const sheet = stylesheetIn(project, page, attributeOf(element, 'href')?.trim() ?? '')
      if (sheet !== undefined)
        declared.push(
          ...fontFaceDescriptors(await readFile(sheet, 'utf8')).map((face) => face.family),
        )
    }
  }
  const missing = new Map<string, string>()
  for (const page of pages) {
    for (const family of undeclaredFontFamilies(contents.get(page) ?? '', declared, fontEngine)) {
      if (!missing.has(family.toLowerCase())) missing.set(family.toLowerCase(), family)
    }
  }
  return [...missing.values()]
}
