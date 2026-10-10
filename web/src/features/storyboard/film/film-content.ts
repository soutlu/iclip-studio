/** 制作页一组里能选的段与舞台上的图：全局设定一段，每个镜头一段；段身份沿用分镜页的内容 id
 * （`global`、`scene:N`），图按它在这组 `frames` 里的位置（从 1 起）认，没有图的也有位置。
 * `frames` 先是参考图列表（`number` 是编号），再是没进列表的机位图（没有编号）。段里的字用 `@ImageN` 指编号为 N 的图，
 * 段挂哪几张图就看字里写了哪几个编号；镜头另挂它的机位图，没进列表的也算。 */

import { encodeContentId } from '../shot-content'
import { extractImageIndexes, promptTitle } from '../shot-document'
import type { FilmFrame, FilmGroup, FilmSetting, FilmShot } from './film.api'

export const SETTINGS_ID = encodeContentId({ kind: 'global' })

export const shotContentId = (number: number) => encodeContentId({ kind: 'scene', scene: number })

/** 这组里能选的段：有设定时全局设定排第一，之后按镜头先后。 */
export const filmContentIds = (group: FilmGroup): string[] => [
  ...(group.settings.length > 0 ? [SETTINGS_ID] : []),
  ...group.shots.map((_, index) => shotContentId(index + 1)),
]

/** 编号为 `number` 的那张图在 `frames` 里的位置；这组没有这个编号时为 undefined。 */
export const positionOfNumber = (group: FilmGroup, number: number): number | undefined => {
  const index = group.frames.findIndex((frame) => frame.number === number)
  return index < 0 ? undefined : index + 1
}

/** 一段挂着的图在 `frames` 里的位置，按先后、去重：全局设定是各段设定的字里写的 `@ImageN`；镜头先是它的机位图
 * （没进列表的也算），再是正文里写的（选用了机位图的镜头开头写着「参考@ImageN，」）。这组没有的编号不算。 */
export const segmentFrames = (group: FilmGroup, contentId: string): number[] => {
  const shot = contentId === SETTINGS_ID ? undefined : shotOf(group, contentId)
  const texts =
    contentId === SETTINGS_ID ? group.settings.map((setting) => setting.text) : (shot?.parts ?? [])
  const view = group.frames.findIndex((frame) => frame.node === shot?.view)
  const cited = extractImageIndexes(texts.join('\n')).flatMap(
    (number) => positionOfNumber(group, number) ?? [],
  )
  return [...new Set([...(view < 0 ? [] : [view + 1]), ...cited])]
}

/** 第几镜；不是镜头段为 undefined。 */
export const shotNumberOf = (contentId: string): number | undefined => {
  const match = /^scene:([1-9]\d*)$/.exec(contentId)
  return match === null ? undefined : Number(match[1])
}

export const shotOf = (group: FilmGroup, contentId: string): FilmShot | undefined => {
  const number = shotNumberOf(contentId)
  return number === undefined ? undefined : group.shots[number - 1]
}

/** 舞台换到第 `position` 张图时文案列选哪段：当前段挂着它就不动，否则选第一段挂着它的；谁都没挂就不动。 */
export const contentOfFrame = (group: FilmGroup, current: string, position: number): string =>
  segmentFrames(group, current).includes(position)
    ? current
    : (filmContentIds(group).find((id) => segmentFrames(group, id).includes(position)) ?? current)

export type FilmSelection = { contentId: string; frame: number | undefined }

/** 路由参数指的段与图；段不在这组里就落回第一段，图不在这组里就用这段挂的第一张。 */
export const resolveFilmSelection = (
  group: FilmGroup,
  requested: { content: string | undefined; frame: number | undefined },
): FilmSelection | undefined => {
  const ids = filmContentIds(group)
  const contentId =
    requested.content !== undefined && ids.includes(requested.content) ? requested.content : ids[0]
  if (contentId === undefined) return undefined
  const frame =
    requested.frame !== undefined && requested.frame >= 1 && requested.frame <= group.frames.length
      ? requested.frame
      : segmentFrames(group, contentId)[0]
  return { contentId, frame }
}

/** 名字后面接中文：以数字或字母结尾时空一格。 */
const beforeChinese = (label: string): string => `${label}${/\w$/.test(label) ? ' ' : ''}`

/** 「镜头 2 暂无图片」「涂鸦滑板场暂无图片」。 */
export const missingImageText = (label: string): string => `${beforeChinese(label)}暂无图片`

/** 生成过、还没选用的那张生成卡的标题：「镜头 2 尚未选用图片」。 */
export const unselectedImageText = (label: string): string => `${beforeChinese(label)}尚未选用图片`

/** 一张图的参考图里有没选用的就不能生成：「参考图尚未选用：涂鸦滑板场、镜头 2，无法生成图片；请先选用图片」，
 * 同名的只写一次；一张都不缺时为 undefined。 */
export const missingReferencesText = (labels: readonly string[]): string | undefined => {
  const names = [...new Set(labels)]
  return names.length === 0
    ? undefined
    : `参考图尚未选用：${names.join('、')}，无法生成图片；请先选用图片`
}

/** 这组参考图列表里有没图的就不能出片：只写张数，「2 张参考图尚未选用，无法生成视频；请先选用图片」，缺哪几张看
 * 参考图条上的「未选用」；没进列表的机位图不发，不算。一张都不缺时为 undefined。 */
export const missingFramesText = (group: FilmGroup): string | undefined => {
  const count = group.frames.filter((frame) => frame.number !== null && frame.url === null).length
  return count === 0 ? undefined : `${count} 张参考图尚未选用，无法生成视频；请先选用图片`
}

/** 舞台标签与悬停预览用的名字：有编号写 @N，没有就写它的名字。 */
export const frameTag = (frame: FilmFrame): string =>
  frame.number === null ? frame.label : `@${frame.number}`

/** 镜头的时间；时长按原始起止秒算。 */
export const shotTime = (shot: FilmShot) => ({
  duration: shot.end - shot.start,
  end: shot.end,
  start: shot.start,
})

/** 这组的总长：最后一镜的止秒。 */
export const filmDuration = (group: FilmGroup): number => group.shots.at(-1)?.end ?? 0

/** 一句台词照页面上的样子：说话人加引号里的字。 */
export const lineText = (line: { role: string; text: string }) => `${line.role}“${line.text}”`

/** 镜头正文连同台词，复制与字数都按它。 */
export const shotText = (shot: Pick<FilmShot, 'parts' | 'lines'>): string =>
  shot.parts.reduce((text, part, index) => {
    const line = shot.lines[index - 1]
    return text + (line === undefined ? '' : lineText(line)) + part
  }, '')

/** 称呼与正文之间：声音的正文开头已经写着说话人，用空格接，与视频提示词里的「声音 旁白：……」同一个样子；其余用「：」。 */
export const settingSeparator = (setting: Pick<FilmSetting, 'kind'>): string =>
  setting.kind === 'voice' ? ' ' : '：'

/** 全局设定的一段照页面上的样子：有称呼的写在前面。 */
export const settingText = (setting: Pick<FilmSetting, 'kind' | 'label' | 'text'>): string =>
  setting.label === null
    ? setting.text
    : `${setting.label}${settingSeparator(setting)}${setting.text}`

/** 顶栏镜头组列表里的一行：缩略图取第一镜的画面，没有就取这组第一张有图的。 */
export const filmGroupSummary = (group: FilmGroup) => {
  const first = group.shots[0]
  const view = group.frames.find((frame) => frame.node === first?.view)?.url
  return {
    aspectRatio: group.aspectRatio,
    index: group.index,
    name:
      (first === undefined ? undefined : promptTitle(shotText(first))) ?? `镜头组 ${group.index}`,
    sceneSeconds: group.shots.map((shot) => shot.end - shot.start),
    seconds: group.seconds,
    thumbnailUrl: view ?? group.frames.find((frame) => frame.url !== null)?.url ?? undefined,
  }
}
