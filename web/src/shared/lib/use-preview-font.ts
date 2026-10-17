import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { getBrandFontInfo, type BrandFontInfo } from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { normalizeCaptionText } from './caption-text'

type FontSource = { id: string; url: string }
const fontReferences = new WeakMap<FontFace, number>()

const retainFont = (face: FontFace): (() => void) => {
  const count = fontReferences.get(face) ?? 0
  if (count === 0) document.fonts.add(face)
  fontReferences.set(face, count + 1)
  return () => {
    const remaining = (fontReferences.get(face) ?? 1) - 1
    if (remaining === 0) {
      fontReferences.delete(face)
      document.fonts.delete(face)
    } else fontReferences.set(face, remaining)
  }
}

export type PreviewFont =
  | { kind: 'system' }
  | { kind: 'loading' }
  | {
      kind: 'ready'
      fontFamily: string
      fontWeight: number
      fontStyle: BrandFontInfo['style']
    }
  | { kind: 'failed'; message: string; retry: () => void }
  | { kind: 'unsupported'; message: string }

const supportsText = (text: string, ranges: BrandFontInfo['unicodeRanges']): boolean => {
  for (const character of normalizeCaptionText(text)) {
    if (character === '\n') continue
    const point = character.codePointAt(0)
    if (point === undefined) continue
    let lower = 0
    let upper = ranges.length - 1
    let supported = false
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2)
      const range = ranges[middle]
      if (range === undefined) break
      if (point < range.start) upper = middle - 1
      else if (point > range.end) lower = middle + 1
      else {
        supported = true
        break
      }
    }
    if (!supported) return false
  }
  return true
}

export function usePreviewFont(font: FontSource | null, text: string): PreviewFont {
  const fontId = font?.id
  const fontUrl = font?.url
  const query = useQuery({
    queryKey: ['preview-font', fontId, fontUrl],
    enabled: font !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      if (fontId === undefined || fontUrl === undefined) throw new Error('系统字体不读取品牌资源')
      const info = await getBrandFontInfo(fontId, signal)
      // 每条资源独享 CSS family：浏览器按 family 与字重匹配，同名、不同字重的文件会互相替换。
      const family = `iclip-brand-font-${fontId}`
      const face = new FontFace(family, `url(${JSON.stringify(fontUrl)})`, {
        weight: String(info.weight),
        style: info.style,
      })
      const loaded = await face.load()
      signal.throwIfAborted()
      return { family, info, face: loaded }
    },
  })
  const face = query.data?.face
  // useSyncExternalStore 在订阅后复核 snapshot，注册完成才返回 ready，Canvas 测字时字体已在字体集里。
  const registered = useSyncExternalStore(
    useCallback(() => (face === undefined ? () => {} : retainFont(face)), [face]),
    useCallback(() => face !== undefined && fontReferences.has(face), [face]),
    () => false,
  )
  const supported = useMemo(
    () => query.data === undefined || supportsText(text, query.data.info.unicodeRanges),
    [query.data, text],
  )
  if (font === null) return { kind: 'system' }
  if (query.isError)
    return {
      kind: 'failed',
      message: errorMessageOf(query.error, '字体加载失败，请重试或选择其他字体'),
      retry: () => void query.refetch(),
    }
  if (query.data === undefined || !registered) return { kind: 'loading' }
  if (!supported)
    return {
      kind: 'unsupported',
      message: '所选字体不包含部分文字，无法显示；请更换文字或字体',
    }
  return {
    kind: 'ready',
    fontFamily: query.data.family,
    fontWeight: query.data.info.weight,
    fontStyle: query.data.info.style,
  }
}
