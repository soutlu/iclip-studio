import { useEffect, useMemo, useRef, useState } from 'react'

export type MediaDurations = Readonly<Record<string, number | null>>

// 素材地址跨域，前端读不到字节；不上屏的 <video preload="metadata"> 是唯一能读到时长的途径。
export const useMediaDurations = (
  urls: readonly string[],
  known: Readonly<Record<string, number>> = {},
): MediaDurations => {
  const [durations, setDurations] = useState<MediaDurations>({})
  const probingRef = useRef(new Set<string>())

  useEffect(() => {
    for (const url of urls) {
      if (url in known || url in durations || probingRef.current.has(url)) continue
      probingRef.current.add(url)
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      const settle = (value: number | null) => {
        video.onloadedmetadata = null
        video.onerror = null
        setDurations((current) => ({ ...current, [url]: value }))
        video.removeAttribute('src')
        video.load()
      }
      video.onloadedmetadata = () => settle(Number.isFinite(video.duration) ? video.duration : null)
      video.onerror = () => settle(null)
      video.src = url
    }
  }, [urls, known, durations])

  return useMemo(() => ({ ...durations, ...known }), [durations, known])
}
