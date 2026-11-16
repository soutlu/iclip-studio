import type { ComponentCatalog } from './composition/catalog'
import { escapeAttribute } from './composition/html'
import type { LocaleValues } from './locales'

const withBaseHref = (html: string, baseHref: string): string => {
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) throw new Error('主文件没有 <head>')
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n<base href="${escapeAttribute(baseHref)}">${html.slice(at)}`
}

// 只改预览，存着的文件不动。preload 写 none 时运行时按播放位置调 load()，一次只加载用得到的片段；
// 写 metadata 会一开始就下载，运行时之后设成 none 也停不下来，几个文件会一起抢带宽。
// 音频片段在文件里不写 preload，这里补上。
const withPreviewMedia = (html: string): string =>
  html
    .replaceAll('<video ', '<video crossorigin="anonymous" ')
    .replaceAll('preload="auto"', 'preload="none"')
    .replaceAll('<audio ', '<audio crossorigin="anonymous" preload="none" ')
    .replace(/<head[^>]*>/i, '$&\n<meta name="hyperframes-studio-preview" content="1">')

/** 主文件根（`<html>` 上的 `data-composition-variables`）声明的变量 id；写法不对时当作没声明。 */
const declaredVariables = (html: string): Set<string> => {
  const declared = new DOMParser()
    .parseFromString(html, 'text/html')
    .documentElement.getAttribute('data-composition-variables')
  let parsed: unknown
  try {
    parsed = JSON.parse(declared ?? '[]')
  } catch {
    return new Set()
  }
  return new Set(
    (Array.isArray(parsed) ? parsed : []).flatMap((declaration: unknown) =>
      typeof declaration === 'object' &&
      declaration !== null &&
      'id' in declaration &&
      typeof declaration.id === 'string'
        ? [declaration.id]
        : [],
    ),
  )
}

/**
 * 预览套上一种语言的值（`values` 是它的值表，中文时是 null，不插）：照官方编辑器，在 `<head>` 开头插一段脚本，
 * 运行库加载时按全局变量 `__hfVariables` 取变量的值。只放主文件根上声明过的 id；`<` 写成转义，值里的
 * `</script>` 不会提前结束脚本。
 */
export function withPreviewVariables(html: string, values: LocaleValues | null): string {
  if (values === null) return html
  const declared = declaredVariables(html)
  const used = Object.fromEntries(Object.entries(values).filter(([id]) => declared.has(id)))
  const json = JSON.stringify(used).replaceAll('<', '\\u003c')
  return html.replace(
    /<head[^>]*>/i,
    (head) => `${head}\n<script data-hf-preview-variables>window.__hfVariables=${json};</script>`,
  )
}

/** 公共组件库当前版本目录的地址。 */
export const catalogBase = (catalog: ComponentCatalog, origin: string) =>
  `${origin}/hyperframes/${catalog.version}/`

/**
 * 预览用的那一份：文件加上基准地址、预览专用的媒体加载方式和语言的值（`values`，见 `withPreviewVariables`）。
 * 文件里的相对地址（组件文件、`vendor/`）都按 `baseHref` 取。
 */
export const previewDocument = (
  html: string,
  baseHref: string,
  values: LocaleValues | null = null,
): string => withPreviewVariables(withBaseHref(withPreviewMedia(html), baseHref), values)

/**
 * 交给预览播放器 `runtime-src` 的运行库地址：组件库里带的那一份。
 * 播放器只认同源（或本机）的绝对地址，别的地址和不给一样，会去外网 CDN 取。
 */
export const previewRuntimeSrc = (catalog: ComponentCatalog, origin: string): string =>
  `${catalogBase(catalog, origin)}${catalog.runtime.hyperframes}`
