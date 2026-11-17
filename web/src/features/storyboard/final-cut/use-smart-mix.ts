import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HfAudioFxChain } from '@hyperframes/core/audio-fx'
import { roleOf, type AudioRole } from './audio-role'
import {
  canCarve,
  carveOf,
  chainOf,
  carvePlan,
  measureCarve,
  nextCarve,
  switchedCarve,
  type CarveDecode,
  type CarveMeasurement,
  type CarveSettings,
} from './carve'
import type { FilmClip, MediaClip } from './composition/film'
import { isLevelled, measureLevelling, type LevellerMeasurement } from './leveller'
import type { ChainChange } from './mix-fx'

/** 「属性」里选中的有声片段的「智能调音」。 */
export type SmartMix = {
  role: AudioRole
  setRole: (role: AudioRole) => void
  carve: CarveSettings | null
  setCarveEnabled: (on: boolean) => void
  setCarveStrength: (strength: number) => void
  /** 开着自动平稳音量（效果链里有它的节点）。 */
  levelled: boolean
  setLevellerEnabled: (on: boolean) => void
  /** 正在分析声音：分析完才写进 final-cut，这期间开关和强度都不能改。 */
  analysing: boolean
  /** 片段现在的效果链：音色风格、均衡、升降调、自己加的效果都从这里读（见 `mix-fx.ts`）。 */
  chain: HfAudioFxChain
  /** 改效果链：一次是一步撤销。 */
  editChain: (change: ChainChange) => void
}

const CARVE_FAILED_TEXT = '自动压低没有生效：人声或配乐的声音读取失败，请重试'
const LEVEL_FAILED_TEXT = '自动平稳音量没有生效：声音读取失败，请重试'
const ALREADY_EVEN_TEXT = '这段声音已经很平稳，不用再调'

/** 量的时候用到的片段的样子：量完以后变了，量的结果就不对了。 */
const inputsKey = (clips: readonly MediaClip[]) =>
  JSON.stringify(
    clips.map((clip) => [
      clip.id,
      clip.src,
      clip.start,
      clip.duration,
      clip.mediaStart,
      clip.playbackRate,
    ]),
  )

/**
 * 时间线上只选中一个有声片段（`clip`）时管它的智能调音：声音角色、自动压低、自动平稳音量。
 *
 * 自动压低照参照的工作台在选中时做：角色是配乐或音效、没设置过、有重叠的人声时默认开，压的人声没了时去掉（见
 * `nextCarve`）；用户在「属性」里开关、改强度。要开着时先分析人声（`decode` 读声音，同一个地址只读一次），量完再
 * 把设置和生成的效果链、曲线交给 `writeCarve`（一步撤销）；关掉、没有人声时直接交，生成的去掉。平稳音量只在用户
 * 打开时量这个片段自己的声音，交给 `writeLeveller`；声音已经平稳（`writeLeveller` 答 false）时提示，不写。
 * 量的时候片段动了就按新的样子重量；读不出声音时用 `onNotice` 提示，不写。两种分析一次只做一个。
 *
 * 同一个片段同样的自动改动一次会话里只做一次：撤销掉自动打开以后不会又被打开。`clips` 要含所有语言的配音片段。
 * 音色风格、均衡、升降调、自己加的效果不用分析，直接交给 `writeFx`。
 */
export function useSmartMix({
  clip,
  clips,
  decode,
  writeCarve,
  writeLeveller,
  writeRole,
  writeFx,
  onNotice,
}: {
  clip: MediaClip | undefined
  clips: readonly FilmClip[]
  decode: CarveDecode
  writeCarve: (
    id: string,
    settings: CarveSettings,
    measured: CarveMeasurement | null,
    grouped: readonly string[],
  ) => void
  writeLeveller: (id: string, measured: LevellerMeasurement | null) => boolean
  writeRole: (id: string, role: AudioRole) => void
  writeFx: (id: string, change: ChainChange) => void
  onNotice: (message: string) => void
}): SmartMix | undefined {
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

  const current = useCallback((id: string) => {
    const found = clipsRef.current.find((candidate) => candidate.id === id)
    return found !== undefined && canCarve(found) ? found : undefined
  }, [])

  /**
   * 量到片段没再变为止：`plan` 按现在的片段给出要量的片段（第一个是这个片段自己）和量法，片段没了时是
   * undefined（不写）。量完片段和量的时候一样才交给 `write`。读不出声音时提示 `failed`。
   */
  const measureSettled = useCallback(
    async <T>(
      id: string,
      plan: () => { inputs: MediaClip[]; measure: () => Promise<T> } | undefined,
      write: (measured: T) => void,
      failed: string,
    ) => {
      let next = plan()
      if (next === undefined) return
      setAnalysing(id)
      try {
        for (;;) {
          const key = inputsKey(next.inputs)
          const measured = await next.measure()
          const now = plan()
          if (now === undefined) return
          if (inputsKey(now.inputs) === key) {
            write(measured)
            return
          }
          next = now
        }
      } catch (error) {
        console.error('final-cut 智能调音分析失败', error)
        onNotice(failed)
      } finally {
        setAnalysing(null)
      }
    },
    [onNotice],
  )

  const applyCarve = useCallback(
    async (id: string, settings: CarveSettings) => {
      const target = current(id)
      if (target === undefined) return
      const { grouped, voices } = carvePlan(target, settings, clipsRef.current)
      if (voices.length === 0) {
        writeCarve(id, settings, null, grouped)
        return
      }
      await measureSettled<{ measured: CarveMeasurement | null; grouped: string[] }>(
        id,
        () => {
          const bed = current(id)
          if (bed === undefined) return undefined
          const plan = carvePlan(bed, settings, clipsRef.current)
          return {
            inputs: [bed, ...plan.voices],
            measure: async () => ({
              measured:
                plan.voices.length === 0
                  ? null
                  : await measureCarve(bed, plan.voices, settings.strength, decoded),
              grouped: plan.grouped,
            }),
          }
        },
        ({ measured, grouped: settled }) => writeCarve(id, settings, measured, settled),
        CARVE_FAILED_TEXT,
      )
    },
    [current, decoded, measureSettled, writeCarve],
  )

  const applyLeveller = useCallback(
    async (id: string, on: boolean) => {
      if (!on) {
        writeLeveller(id, null)
        return
      }
      await measureSettled<LevellerMeasurement>(
        id,
        () => {
          const target = current(id)
          if (target === undefined) return undefined
          return { inputs: [target], measure: () => measureLevelling(target, decoded) }
        },
        (measured) => {
          if (!writeLeveller(id, measured)) onNotice(ALREADY_EVEN_TEXT)
        },
        LEVEL_FAILED_TEXT,
      )
    },
    [current, decoded, measureSettled, onNotice, writeLeveller],
  )

  useEffect(() => {
    if (clip === undefined || analysing !== null) return
    const next = nextCarve(clip, clips)
    if (next === null) return
    // 从哪个设置改成哪个：撤销回到同一个设置时不再做，名单清空以后再换回人声组照做
    const decision = `${clip.id}\n${clip.fxCarve ?? ''}\n${JSON.stringify(next)}`
    if (decidedRef.current.has(decision)) return
    decidedRef.current.add(decision)
    void applyCarve(clip.id, next)
  }, [analysing, applyCarve, clip, clips])

  if (clip === undefined) return undefined
  const carve = carveOf(clip)
  return {
    role: roleOf(clip),
    setRole: (role) => writeRole(clip.id, role),
    carve,
    setCarveEnabled: (on) => void applyCarve(clip.id, switchedCarve(clip, clips, on)),
    setCarveStrength: (strength) => {
      if (carve !== null) void applyCarve(clip.id, { ...carve, strength })
    },
    levelled: isLevelled(clip),
    setLevellerEnabled: (on) => void applyLeveller(clip.id, on),
    analysing: analysing === clip.id,
    chain: chainOf(clip.fxChain ?? undefined),
    editChain: (change) => writeFx(clip.id, change),
  }
}
