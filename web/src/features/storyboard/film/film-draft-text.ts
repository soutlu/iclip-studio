/** 制作页改字草稿里的图片引用。页面上的字用编号 `@ImageN` 指这组参考图列表的第 N 张，编号会因为别处插入、删除图片或
 * 选用机位图而变；草稿要跨过这些变化，所以存图的身份：列表里现有的图记节点名，新插入的图记地址。页面上显示时按当下的
 * 列表换回编号（新图画成「新」芯片），发给后端时按 `PATCH .../film/text` 的约定编号（见 contract/conventions.md §6）：
 * 列表现有 M 张，新图从 M+1 起依次排进 `images`；地址就是列表里某张图的，用那张的编号。
 *
 * 两种记号都用私用区字符包起来，用户敲不出来，也不会与 `@ImageN` 混在一起。 */

import type { FilmGroup } from './film.api'

const OPEN_NEW = ''
const OPEN_NODE = ''
const CLOSE = ''

/** 页面上的字（编辑器交出来的）里的记号：`@ImageN` 与新插入的图。 */
const SHOWN_TOKEN = /@Image(\d+)|([^]*)/g

/** 草稿里的记号：现有的图（节点名）与新插入的图（地址）。 */
const DRAFT_TOKEN = /([^]*)|([^]*)/g

/** 编辑器正文里新插入的图的记号：帧节点的原文记号就是它，草稿里原样保留。 */
export const newImageToken = (url: string): string => `${OPEN_NEW}${url}${CLOSE}`

/** 新插入的图的记号里的地址；不是这种记号为 undefined。 */
export const newImageUrl = (token: string): string | undefined =>
  token.startsWith(OPEN_NEW) && token.endsWith(CLOSE) ? token.slice(1, -1) : undefined

/** 编辑器认的记号：`@ImageN` 与新插入的图，帧节点按它拆。 */
export const FILM_TOKEN = SHOWN_TOKEN

const listed = (group: FilmGroup) => group.frames.filter((frame) => frame.number !== null)

/** 页面上的字换成草稿：列表里有的编号记成那张图的节点名；这组没有的编号原样留着，保存时由后端拒绝。 */
export const toDraftText = (text: string, group: FilmGroup): string =>
  text.replace(SHOWN_TOKEN, (token, digits: string | undefined) => {
    if (digits === undefined) return token
    const frame = listed(group).find((item) => item.number === Number(digits))
    return frame === undefined ? token : `${OPEN_NODE}${frame.node}${CLOSE}`
  })

/** 草稿换成页面上的字：节点名按当下的列表写回编号；那张图已不在列表里时写 `@Image0`，画成空位，保存时由后端拒绝。
 * 新插入的图原样留着记号。 */
export const toShownText = (text: string, group: FilmGroup): string =>
  text.replace(DRAFT_TOKEN, (token, node: string | undefined) => {
    if (node === undefined) return token
    const frame = listed(group).find((item) => item.node === node)
    return `@Image${String(frame?.number ?? 0)}`
  })

/** 草稿换成发给后端的字：现有的图写当下的编号，新插入的图按约定从 M+1 起编，地址依次追加进 `images`（同一地址只记一次）；
 * 地址就是列表里某张图的，写那张的编号。一段镜头的几段文字共用同一个 `images`。 */
export const toRequestText = (text: string, group: FilmGroup, images: string[]): string => {
  const frames = listed(group)
  return text.replace(DRAFT_TOKEN, (_, node: string | undefined, url: string | undefined) => {
    if (node !== undefined) {
      const frame = frames.find((item) => item.node === node)
      return `@Image${String(frame?.number ?? 0)}`
    }
    const address = url ?? ''
    const same = frames.find((item) => item.url === address)
    if (same?.number != null) return `@Image${String(same.number)}`
    if (!images.includes(address)) images.push(address)
    return `@Image${String(frames.length + images.indexOf(address) + 1)}`
  })
}
