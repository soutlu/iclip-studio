import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  carveOf,
  carveOffered,
  isCarveBed,
  isCarveVoice,
  measureCarve,
  nextCarve,
  switchedCarve,
  type CarveDecode,
  type CarveMeasurement,
  type CarveSettings,
} from './carve'
import type { AudioClip, FilmClip, MediaClip } from './composition/film'

/** 「属性」里选中的配乐片段的「自动压低」。 */
export type MusicCarve = {
  /** 要不要显示：开着，或者有和它重叠的人声。 */
  offered: boolean
  settings: CarveSettings | null
  /** 正在分析人声：分析完才写进 final-cut，这期间开关和强度不能改。 */
  analysing: boolean
  setEnabled: (on: boolean) => void
  setStrength: (strength: number) => void
}

const CARVE_FAILED_TEXT = '自动压低没有生效：人声或配乐的声音读取失败，请重试'

/** 量的时候用到的片段的样子：量完以后变了，量的结果就不对了。 */
const inputsKey = (bed: AudioClip, voices: readonly MediaClip[]) =>
  JSON.stringify(
    [bed, ...voices].map((clip) => [
      clip.id,
      clip.src,
      clip.start,
      clip.duration,
      clip.mediaStart,
      clip.playbackRate,
    ]),
  )

/**
 * 时间线上只选中一段配乐（`bed`）时管它的压低配乐，照参照的工作台在选中时做：没设置过、有重叠的人声时默认开，
 * 压的人声删了时去掉（见 `nextCarve`）；用户在「属性」里开关、改强度。要开着时先分析人声（`decode` 读声音，
 * 同一个地址只读一次），量完再把设置和生成的效果链、曲线一起交给 `write`（一步撤销）；关掉、没有人声时直接交，
 * 生成的去掉。量的时候片段动了就按新的样子重量。读不出声音时用 `onNotice` 提示，不写。
 *
 * 同一段配乐同样的自动改动一次会话里只做一次：撤销掉自动打开以后不会又被打开。`clips` 要含所有语言的配音片段。
 */
export function useMusicCarve({
  bed,
  clips,
  decode,
  write,
  onNotice,
}: {
  bed: AudioClip | undefined
  clips: readonly FilmClip[]
  decode: CarveDecode
  write: (id: string, settings: CarveSettings, measured: CarveMeasurement | null) => void
  onNotice: (message: string) => void
}): MusicCarve | undefined {
  const [analysing, setAnalysing] = useState<string | null>(null)
  const clipsRef = useRef(clips)
  useLayoutEffect(() => {
    clipsRef.current = clips
  })
  const decodedRef = useRef(new Map<string, Promise<Float32Array>>())
  const decidedRef = useRef(new Set<string>())

  const decoded = useCallback<CarveDecode>(
    (src) => {
      const cache = decodedRef.current
      const known = cache.get(src)
      if (known !== undefined) return known
      const reading = decode(src)
      cache.set(src, reading)
      // 读失败的不留着，下次重读
      void reading.catch(() => cache.delete(src))
      return reading
    },
    [decode],
  )

  const apply = useCallback(
    async (bedId: string, next: CarveSettings) => {
      // 按现在的片段找配乐和设置里压的人声
      const find = () => {
        const all = clipsRef.current
        const found = all.find((clip) => clip.id === bedId)
        if (found === undefined || !isCarveBed(found)) return undefined
        const voices = next.sources.flatMap((id) => {
          const voice = all.find((clip) => clip.id === id)
          return voice !== undefined && isCarveVoice(voice) ? [voice] : []
        })
        return { bed: found, voices }
      }
      let current = find()
      if (current === undefined) return
      if (!next.enabled || current.voices.length === 0) {
        write(bedId, next, null)
        return
      }
      setAnalysing(bedId)
      try {
        for (;;) {
          const key = inputsKey(current.bed, current.voices)
          const measured = await measureCarve(current.bed, current.voices, next.strength, decoded)
          const now = find()
          if (now === undefined) return
          if (inputsKey(now.bed, now.voices) === key) {
            write(bedId, next, measured)
            return
          }
          current = now
          if (current.voices.length === 0) {
            write(bedId, next, null)
            return
          }
        }
      } catch (error) {
        console.error('final-cut 压低配乐分析失败', error)
        onNotice(CARVE_FAILED_TEXT)
      } finally {
        setAnalysing(null)
      }
    },
    [decoded, onNotice, write],
  )

  useEffect(() => {
    if (bed === undefined || analysing !== null) return
    const next = nextCarve(bed, clips)
    if (next === null) return
    const decision = `${bed.id}\n${JSON.stringify(next)}`
    if (decidedRef.current.has(decision)) return
    decidedRef.current.add(decision)
    void apply(bed.id, next)
  }, [analysing, apply, bed, clips])

  if (bed === undefined) return undefined
  const settings = carveOf(bed)
  return {
    offered: carveOffered(bed, clips),
    settings,
    analysing: analysing === bed.id,
    setEnabled: (on) => void apply(bed.id, switchedCarve(bed, clips, on)),
    setStrength: (strength) => {
      if (settings !== null) void apply(bed.id, { ...settings, strength })
    },
  }
}
