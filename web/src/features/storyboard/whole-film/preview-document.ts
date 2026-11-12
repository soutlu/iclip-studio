import type { ComponentCatalog } from './composition/catalog'
import { escapeAttribute } from './composition/html'

const withBaseHref = (html: string, baseHref: string): string => {
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) throw new Error('成片文件没有 <head>')
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n<base href="${escapeAttribute(baseHref)}">${html.slice(at)}`
}

// 只改预览，存着的成片文件不动。preload 写 none 时运行时按播放位置调 load()，一次只加载用得到的片段；
// 写 metadata 会一开始就下载，运行时之后设成 none 也停不下来，几个文件会一起抢带宽。
const withPreviewMedia = (html: string): string =>
  html
    .replaceAll('<video ', '<video crossorigin="anonymous" ')
    .replaceAll('preload="auto"', 'preload="none"')
    .replace(/<head[^>]*>/i, '$&\n<meta name="hyperframes-studio-preview" content="1">')

/** 预览用的那一份：成片文件加上组件库的基准地址和预览专用的媒体加载方式。 */
export const previewDocument = (html: string, catalog: ComponentCatalog, origin: string): string =>
  withBaseHref(withPreviewMedia(html), `${origin}/hyperframes/${catalog.version}/`)
