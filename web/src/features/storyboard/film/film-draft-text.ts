import type { FilmGroup } from './film.api'

const OPEN_NEW = ''
const OPEN_NODE = ''
const CLOSE = ''

const SHOWN_TOKEN = /@Image(\d+)|([^]*)/g

const DRAFT_TOKEN = /([^]*)|([^]*)/g

export const newImageToken = (url: string): string => `${OPEN_NEW}${url}${CLOSE}`

export const newImageUrl = (token: string): string | undefined =>
  token.startsWith(OPEN_NEW) && token.endsWith(CLOSE) ? token.slice(1, -1) : undefined

export const FILM_TOKEN = SHOWN_TOKEN

const listed = (group: FilmGroup) => group.frames.filter((frame) => frame.number !== null)

export const toDraftText = (text: string, group: FilmGroup): string =>
  text.replace(SHOWN_TOKEN, (token, digits: string | undefined) => {
    if (digits === undefined) return token
    const frame = listed(group).find((item) => item.number === Number(digits))
    return frame === undefined ? token : `${OPEN_NODE}${frame.node}${CLOSE}`
  })

export const toShownText = (text: string, group: FilmGroup): string =>
  text.replace(DRAFT_TOKEN, (token, node: string | undefined) => {
    if (node === undefined) return token
    const frame = listed(group).find((item) => item.node === node)
    return `@Image${String(frame?.number ?? 0)}`
  })

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
