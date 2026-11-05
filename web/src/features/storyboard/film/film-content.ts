import { encodeContentId } from '../shot-content'
import { extractImageIndexes, promptTitle } from '../shot-document'
import type { FilmFrame, FilmGroup, FilmSetting, FilmShot } from './film.api'

export const SETTINGS_ID = encodeContentId({ kind: 'global' })

export const shotContentId = (number: number) => encodeContentId({ kind: 'scene', scene: number })

export const filmContentIds = (group: FilmGroup): string[] => [
  ...(group.settings.length > 0 ? [SETTINGS_ID] : []),
  ...group.shots.map((_, index) => shotContentId(index + 1)),
]

export const positionOfNumber = (group: FilmGroup, number: number): number | undefined => {
  const index = group.frames.findIndex((frame) => frame.number === number)
  return index < 0 ? undefined : index + 1
}

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

export const shotNumberOf = (contentId: string): number | undefined => {
  const match = /^scene:([1-9]\d*)$/.exec(contentId)
  return match === null ? undefined : Number(match[1])
}

export const shotOf = (group: FilmGroup, contentId: string): FilmShot | undefined => {
  const number = shotNumberOf(contentId)
  return number === undefined ? undefined : group.shots[number - 1]
}

export const contentOfFrame = (group: FilmGroup, current: string, position: number): string =>
  segmentFrames(group, current).includes(position)
    ? current
    : (filmContentIds(group).find((id) => segmentFrames(group, id).includes(position)) ?? current)

export type FilmSelection = { contentId: string; frame: number | undefined }

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

const beforeChinese = (label: string): string => `${label}${/\w$/.test(label) ? ' ' : ''}`

export const missingImageText = (label: string): string => `${beforeChinese(label)}暂无图片`

export const unselectedImageText = (label: string): string => `${beforeChinese(label)}尚未选用图片`

export const missingReferencesText = (labels: readonly string[]): string | undefined => {
  const names = [...new Set(labels)]
  return names.length === 0
    ? undefined
    : `参考图尚未选用：${names.join('、')}，无法生成图片；请先生成并选用图片`
}

export const missingFramesText = (group: FilmGroup): string | undefined => {
  const count = group.frames.filter((frame) => frame.number !== null && frame.url === null).length
  return count === 0 ? undefined : `${count} 张参考图尚未选用，无法生成视频；请先生成并选用图片`
}

export const frameTag = (frame: FilmFrame): string =>
  frame.number === null ? frame.label : `@${frame.number}`

export const shotTime = (shot: FilmShot) => ({
  duration: shot.end - shot.start,
  end: shot.end,
  start: shot.start,
})

export const filmDuration = (group: FilmGroup): number => group.shots.at(-1)?.end ?? 0

export const lineText = (line: { role: string; text: string }) => `${line.role}“${line.text}”`

export const shotText = (shot: Pick<FilmShot, 'parts' | 'lines'>): string =>
  shot.parts.reduce((text, part, index) => {
    const line = shot.lines[index - 1]
    return text + (line === undefined ? '' : lineText(line)) + part
  }, '')

export const settingSeparator = (setting: Pick<FilmSetting, 'kind'>): string =>
  setting.kind === 'voice' ? ' ' : '：'

export const settingText = (setting: Pick<FilmSetting, 'kind' | 'label' | 'text'>): string =>
  setting.label === null
    ? setting.text
    : `${setting.label}${settingSeparator(setting)}${setting.text}`

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
