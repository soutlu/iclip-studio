import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HfAutomation } from '@hyperframes/core/audio-automation'
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
import { volumePointsOf, withEnvelope, withFlatEnvelope } from './volume-envelope'

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
  /** 开着波形音量关键帧：片段的曲线里有音量曲线（见 `volume-envelope.ts`）。 */
  envelope: boolean
  /** 打开（没有音量曲线时加平的一条）或关掉（去掉音量曲线），一步撤销。 */
  setEnvelope: (on: boolean) => void
  /** 音量曲线换回平的一条，一步撤销。 */
  resetEnvelope: () => void
}

/** 改片段曲线（`data-automation`）的一步：拿现在的曲线，给出改好的。 */
export type AutomationChange = (automation: HfAutomation) => HfAutomation

const CARVE_FAILED_TEXT = '自动压低未生效：人声或配乐音频读取失败，请重试'
const LEVEL_FAILED_TEXT = '自动平稳音量未生效：音频读取失败，请重试'
const ALREADY_EVEN_TEXT = '该片段音量已较平稳，无需调整'

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
 * 一次量的输入：`key` 是除了片段自己的时长以外的输入，`covers` 是量的时候片段有多长。片段只是变短（裁结尾、
 * 切开的前半段）时剩下的曲线就是量出来的那样，不算过时；变长了、别的输入变了才算。
 */
type Measured = { key: string; covers: number }

/** 开着的压低量的输入：片段自己和按设置 `carve` 要量的人声（见 `carvePlan`）。 */
const carveInputs = (
  bed: MediaClip,
  carve: CarveSettings,
  clips: readonly FilmClip[],
): Measured => ({
  key: JSON.stringify([
    [bed.id, bed.src, bed.start, bed.mediaStart, bed.playbackRate],
    inputsKey(carvePlan(bed, carve, clips).voices),
  ]),
  covers: bed.duration,
})

/** 开着压低（名单不空）时量的输入；没开着时是 undefined。 */
const carveInputsOf = (clip: MediaClip, clips: readonly FilmClip[]) => {
  const carve = carveOf(clip)
  return carve?.enabled === true && carve.sources.length > 0
    ? carveInputs(clip, carve, clips)
    : undefined
}

/** 平稳音量量的输入：只有片段自己放的那段素材，开始不算（曲线在片段时钟上）。 */
const levelInputs = (clip: MediaClip): Measured => ({
  key: JSON.stringify([clip.id, clip.src, clip.mediaStart, clip.playbackRate]),
  covers: clip.duration,
})

/** 按 `was` 量出来的曲线放到现在的输入 `now` 上过时了没有。 */
const outdated = (was: Measured | undefined, now: Measured) =>
  was !== undefined && (was.key !== now.key || now.covers > was.covers)

/** 这次会话里每个片段上一次量（或打开时就有）的压低、平稳音量是按什么输入量的。 */
const carveRecord = (id: string) => `carve\n${id}`
const levelRecord = (id: string) => `level\n${id}`

/**
 * 时间线上只选中一个有声片段（`clip`）时管它的智能调音：声音角色、自动压低、自动平稳音量。
 *
 * 自动压低照参照的工作台在选中时做：角色是配乐或音效、没设置过、有重叠的人声时默认开，压的人声没了时去掉（见
 * `nextCarve`）；用户在「属性」里开关、改强度。要开着时先分析人声（`decode` 读声音，同一个地址只读一次），量完再
 * 把设置和生成的效果链、曲线交给 `writeCarve`（一步撤销）；关掉、没有人声时直接交，生成的去掉。平稳音量只在用户
 * 打开时量这个片段自己的声音，交给 `writeLeveller`；声音已经平稳（`writeLeveller` 答 false）时提示，不写。
 * 量的时候片段动了就按新的样子重量；读不出声音时用 `onNotice` 提示，不写。两种分析一次只做一个。
 * 选中开着压低或平稳音量的片段时，量的输入（压低：片段和要压的人声；平稳音量：片段自己，开始不算）和这次会话里
 * 上次量的时候（打开时就开着的，当作和那时的输入一致）比过时了（见 `outdated`：片段只是变短不算），就照现在的
 * 设置重量，量出来不一样才写（一步撤销）；没选中的片段不重量。
 *
 * 同一个片段同样的自动改动一次会话里只做一次：撤销掉自动打开以后不会又被打开。`clips` 要含所有语言的配音片段。
 * 音色风格、均衡、升降调、自己加的效果不用分析，直接交给 `writeFx`；波形音量关键帧的开关、重置交给 `writeAutomation`。
 */
export function useSmartMix({
  clip,
  clips,
  decode,
  writeCarve,
  writeLeveller,
  writeRole,
  writeFx,
  writeAutomation,
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
  writeAutomation: (id: string, change: AutomationChange) => void
  onNotice: (message: string) => void
}): SmartMix | undefined {
  const [analysing, setAnalysing] = useState<string | null>(null)
  const clipsRef = useRef(clips)
  useLayoutEffect(() => {
    clipsRef.current = clips
  })
  const decodedRef = useRef(new Map<string, Promise<Float32Array>>())
  const decidedRef = useRef(new Set<string>())
  // 见 `carveRecord`：打开时就有的当作和当时的输入一致；量过（成没成、写没写）就换成量的那次
  const measuredRef = useRef(new Map<string, Measured>())
  useLayoutEffect(() => {
    const measured = measuredRef.current
    for (const each of clips) {
      if (!canCarve(each)) continue
      const carve = carveInputsOf(each, clips)
      if (carve !== undefined && !measured.has(carveRecord(each.id)))
        measured.set(carveRecord(each.id), carve)
      if (isLevelled(each) && !measured.has(levelRecord(each.id)))
        measured.set(levelRecord(each.id), levelInputs(each))
    }
  }, [clips])

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
   * 量到片段没再变为止：`plan` 按现在的片段给出要量的片段（`inputs`，见 `inputsKey`）、记下来的输入
   * （`measured`，见 `Measured`）和量法，片段没了时是 undefined（不写）。量完片段和量的时候一样才交给 `write`。
   * 每次量都把输入记在 `record` 下。读不出声音时提示 `failed`。
   */
  const measureSettled = useCallback(
    async <T>(
      id: string,
      record: string,
      plan: () =>
        { inputs: MediaClip[]; measured: Measured; measure: () => Promise<T> } | undefined,
      write: (measured: T) => void,
      failed: string,
    ) => {
      let next = plan()
      if (next === undefined) return
      setAnalysing(id)
      try {
        for (;;) {
          const key = inputsKey(next.inputs)
          measuredRef.current.set(record, next.measured)
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
        measuredRef.current.set(carveRecord(id), carveInputs(target, settings, clipsRef.current))
        writeCarve(id, settings, null, grouped)
        return
      }
      await measureSettled<{ measured: CarveMeasurement | null; grouped: string[] }>(
        id,
        carveRecord(id),
        () => {
          const bed = current(id)
          if (bed === undefined) return undefined
          const plan = carvePlan(bed, settings, clipsRef.current)
          return {
            inputs: [bed, ...plan.voices],
            measured: carveInputs(bed, settings, clipsRef.current),
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

  /** 开、关平稳音量；开着时量（`prompted` 是用户点的：声音已经平稳时提示）。 */
  const applyLeveller = useCallback(
    async (id: string, on: boolean, prompted: boolean) => {
      if (!on) {
        writeLeveller(id, null)
        return
      }
      await measureSettled<LevellerMeasurement>(
        id,
        levelRecord(id),
        () => {
          const target = current(id)
          if (target === undefined) return undefined
          return {
            inputs: [target],
            measured: levelInputs(target),
            measure: () => measureLevelling(target, decoded),
          }
        },
        (measured) => {
          if (!writeLeveller(id, measured) && prompted) onNotice(ALREADY_EVEN_TEXT)
        },
        LEVEL_FAILED_TEXT,
      )
    },
    [current, decoded, measureSettled, onNotice, writeLeveller],
  )

  useEffect(() => {
    if (clip === undefined || analysing !== null) return
    const next = nextCarve(clip, clips)
    // 从哪个设置改成哪个：撤销回到同一个设置时不再做，名单清空以后再换回人声组照做
    const decision = `${clip.id}\n${clip.fxCarve ?? ''}\n${JSON.stringify(next)}`
    if (next !== null && !decidedRef.current.has(decision)) {
      decidedRef.current.add(decision)
      void applyCarve(clip.id, next)
      return
    }
    // 量的输入和上次量的时候比过时了：重新量，量出来不一样才写。记下这次的输入，撤销掉以后同样的输入不再量
    const measured = measuredRef.current
    const carve = carveOf(clip)
    const carveNow = carveInputsOf(clip, clips)
    if (
      carve !== null &&
      carveNow !== undefined &&
      outdated(measured.get(carveRecord(clip.id)), carveNow)
    ) {
      measured.set(carveRecord(clip.id), carveNow)
      void applyCarve(clip.id, carve)
      return
    }
    const levelNow = levelInputs(clip)
    if (isLevelled(clip) && outdated(measured.get(levelRecord(clip.id)), levelNow)) {
      measured.set(levelRecord(clip.id), levelNow)
      void applyLeveller(clip.id, true, false)
    }
  }, [analysing, applyCarve, applyLeveller, clip, clips])

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
    setLevellerEnabled: (on) => void applyLeveller(clip.id, on, true),
    analysing: analysing === clip.id,
    chain: chainOf(clip.fxChain ?? undefined),
    editChain: (change) => writeFx(clip.id, change),
    envelope: volumePointsOf(clip.automation) !== null,
    setEnvelope: (on) =>
      writeAutomation(clip.id, (automation) => withEnvelope(automation, on, clip.duration / 1000)),
    resetEnvelope: () =>
      writeAutomation(clip.id, (automation) => withFlatEnvelope(automation, clip.duration / 1000)),
  }
}
