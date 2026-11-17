import type { ComponentCatalog } from './composition/catalog'
import { variableValuesOf } from './composition/film'
import { escapeAttribute } from './composition/html'
import { LOCALE_BINDINGS, localeBindingsOf, localizedHostValues } from './composition/locale-text'
import type { LocaleValues } from './locales'
import { withPreviewMediaTags } from './preview-media'

const withBaseHref = (html: string, baseHref: string): string => {
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) throw new Error('主文件没有 <head>')
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n<base href="${escapeAttribute(baseHref)}">${html.slice(at)}`
}

const withPreviewMedia = (html: string): string =>
  withPreviewMediaTags(html).replace(
    /<head[^>]*>/i,
    '$&\n<meta name="hyperframes-studio-preview" content="1">',
  )

/** 主文件根（`<html>` 上的 `data-composition-variables`）声明的变量，id → 默认值；写法不对时当作没声明。 */
const declaredVariables = (root: Element): Map<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(root.getAttribute('data-composition-variables') ?? '[]')
  } catch {
    return new Map()
  }
  return new Map(
    (Array.isArray(parsed) ? parsed : []).flatMap((declaration: unknown) =>
      typeof declaration === 'object' &&
      declaration !== null &&
      'id' in declaration &&
      typeof declaration.id === 'string'
        ? [[declaration.id, 'default' in declaration ? declaration.default : undefined] as const]
        : [],
    ),
  )
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

// 写回时带上文档类型：少了它预览会按怪异模式排版
const serialize = (film: Document): string => {
  const doctype = film.doctype === null ? '' : `<!doctype ${film.doctype.name}>\n`
  return `${doctype}${film.documentElement.outerHTML}\n`
}

/**
 * 去掉主文件根（最外层带 `data-composition-id` 的元素）下这一层带 `data-hidden` 的片段；没有时原样返回。
 * 只给预览用：播放器报「画好了」之前要等盖着第 0 秒的视频、音频都加载好（最多 8 秒），它不看隐藏标记，
 * 而运行库不一定加载隐藏的媒体，等不到时每次换文件都白等满 8 秒。隐藏的片段本来就不显示、不出声，
 * 总长写在根上，去掉不影响播放。
 */
export function withoutHiddenClips(html: string): string {
  const film = parse(html)
  const hidden = [...(film.querySelector('[data-composition-id]')?.children ?? [])].filter(
    (child) => child.hasAttribute('data-hidden'),
  )
  if (hidden.length === 0) return html
  for (const clip of hidden) clip.remove()
  return serialize(film)
}

/**
 * 预览一种外语时（`values` 是它的值表，中文时是 null，不改）：随语言的字段的字并进各宿主的
 * `data-variable-values`（规则见 `localizedHostValues`）。没有宿主要改时原样返回。
 */
export function withLocalizedHosts(html: string, values: LocaleValues | null): string {
  if (values === null) return html
  const film = parse(html)
  const elements = [...film.querySelectorAll(`[${LOCALE_BINDINGS}]`)]
  const localized = localizedHostValues(
    elements.map((element, index) => ({
      id: String(index),
      values: variableValuesOf(element.getAttribute('data-variable-values') ?? '{}') ?? {},
      bindings: localeBindingsOf(element.getAttribute(LOCALE_BINDINGS) ?? undefined),
    })),
    values,
    declaredVariables(film.documentElement),
  )
  if (localized.size === 0) return html
  for (const [index, next] of localized)
    elements[Number(index)]?.setAttribute('data-variable-values', JSON.stringify(next))
  return serialize(film)
}

/**
 * 预览套上一种语言的值（`values` 是它的值表，中文时是 null，不插）：照官方编辑器，在 `<head>` 开头插一段脚本，
 * 运行库加载时按全局变量 `__hfVariables` 取变量的值。只放主文件根上声明过的 id；`<` 写成转义，值里的
 * `</script>` 不会提前结束脚本。
 */
export function withPreviewVariables(html: string, values: LocaleValues | null): string {
  if (values === null) return html
  const declared = declaredVariables(parse(html).documentElement)
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
 * 预览用的那一份：去掉隐藏的片段（见 `withoutHiddenClips`），加上基准地址、预览专用的媒体加载方式和
 * 语言的值（`values`：贴片、场景的字见 `withLocalizedHosts`，字幕的字见 `withPreviewVariables`）。
 * 文件里的相对地址（组件文件、`vendor/`）都按 `baseHref` 取。
 */
export const previewDocument = (
  html: string,
  baseHref: string,
  values: LocaleValues | null = null,
): string =>
  withPreviewVariables(
    withBaseHref(withPreviewMedia(withLocalizedHosts(withoutHiddenClips(html), values)), baseHref),
    values,
  )

/**
 * 交给预览播放器 `runtime-src` 的运行库地址：组件库里带的那一份。
 * 播放器只认同源（或本机）的绝对地址，别的地址和不给一样，会去外网 CDN 取。
 */
export const previewRuntimeSrc = (catalog: ComponentCatalog, origin: string): string =>
  `${catalogBase(catalog, origin)}${catalog.runtime.hyperframes}`
