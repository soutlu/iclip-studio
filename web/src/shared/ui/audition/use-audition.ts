import { useEffect, useRef, useState } from 'react'

type AuditionOptions = {
  /** 试听所在的地方是不是正显示着；被藏起来（没有卸掉）时停下。 */
  active: boolean
  /** 放不出来时调。 */
  onError: () => void
}

/**
 * 音频试听：同一时间只放一条，所有条目共用一个播放器。`playing` 是正在放的那一条的编号（没在放时是 null），
 * `toggle` 放这一条（正在放它时是停下），放完自动停。组件卸掉、`active` 变成假时都停下。
 */
export function useAudition({ active, onError }: AuditionOptions) {
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(
    () => () => {
      audioRef.current?.pause()
    },
    [],
  )
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active) setPlaying(null)
  }
  useEffect(() => {
    if (!active) audioRef.current?.pause()
  }, [active])

  const toggle = (id: string, url: string) => {
    const audio = audioRef.current ?? new Audio()
    if (audioRef.current === null) {
      audio.addEventListener('ended', () => setPlaying(null))
      audioRef.current = audio
    }
    if (playing === id) {
      audio.pause()
      setPlaying(null)
      return
    }
    audio.setAttribute('src', url)
    setPlaying(id)
    audio.play().catch(() => {
      setPlaying(null)
      onError()
    })
  }

  return { playing, toggle }
}
