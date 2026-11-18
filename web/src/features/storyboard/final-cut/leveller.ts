import { levellingResult, removeLevelling } from '@hyperframes/core/audio-leveller'
import { timeAtSourceTime } from '@hyperframes/core/speed-ramp'
import {
  automationOf,
  automationText,
  CARVE_SAMPLE_RATE,
  chainOf,
  chainText,
  clockOf,
  type CarveDecode,
} from './carve'
import type { MediaClip } from './composition/film'
import { clipSourceWindow } from './vendor/hyperframes-studio/components/editor/clipAudioClock'

/**
 * 自动平稳音量：量片段自己的声音，把轻的地方抬起来、响的地方压一点，用 core 的「Even Out Levels」
 * （`@hyperframes/core/audio-leveller`），做法照参照的工作台（`useFxLevelling.ts`）：只有开和关，强度用 core 的
 * 默认值。生成的是效果链里一个带 `fromLeveller` 的增益节点和推它的曲线，写进 `data-fx-chain`、
 * `data-automation`，预览和导出都按它放；开没开就看效果链里有没有这个节点。
 */

/** 片段开着平稳音量：效果链里有平稳音量的节点。 */
export const isLevelled = (clip: MediaClip): boolean =>
  chainOf(clip.fxChain ?? undefined).nodes.some((node) => node.fromLeveller === true)

/** 量出来的：片段实际放的那段素材的声音（还在素材的时钟上，采样率 `CARVE_SAMPLE_RATE`）和片段的速度。 */
export type LevellerMeasurement = { samples: Float32Array; rate: number }

/** 读出片段 `clip` 实际放的那段素材的声音（照工作台：按入点、速度、时长截取素材）。读不出时把错误抛出去。 */
export async function measureLevelling(
  clip: MediaClip,
  decode: CarveDecode,
): Promise<LevellerMeasurement> {
  const samples = clipSourceWindow(await decode(clip.src), CARVE_SAMPLE_RATE, clockOf(clip))
  return { samples, rate: clip.playbackRate }
}

/**
 * 片段上的效果链 `chain`、曲线 `automation`（属性原来的值）换成这次的结果以后要写的值（null 是去掉这个属性）：
 * `measured` 是新量的声音时，用 core 的 `levellingResult`（默认强度）算出平稳音量的节点（已有的原位换掉）和曲线
 * （曲线的时间从素材时钟换到片段时钟，照工作台）；声音已经平稳、没什么可调时答 null（什么都不写）。`measured`
 * 是 null 时用 `removeLevelling` 去掉节点和它的曲线。别的节点和曲线都留着。
 */
export function levellerAttributes(
  chain: string | undefined,
  automation: string | undefined,
  measured: LevellerMeasurement | null,
): { chain: string | null; automation: string | null } | null {
  const before = chainOf(chain)
  const lanes = automationOf(automation).lanes
  if (measured === null) {
    const { chain: next, removedTarget } = removeLevelling(before)
    return {
      chain: chainText(next),
      automation: automationText({
        version: 1,
        lanes: lanes.filter((lane) => lane.target !== removedTarget),
      }),
    }
  }
  const result = levellingResult(before, measured.samples, CARVE_SAMPLE_RATE)
  const lane = result?.automation.lanes[0]
  if (result === null || lane === undefined) return null
  const points = lane.points.map((point) => ({
    ...point,
    t: Number(timeAtSourceTime(measured.rate, point.t).toFixed(3)),
  }))
  const levelled = { ...lane, points }
  // 已有的原位换掉：重新量出来一样时，写出来的也和原来一样
  const replaced = lanes.some((other) => other.target === lane.target)
  return {
    chain: chainText(result.chain),
    automation: automationText({
      version: 1,
      lanes: replaced
        ? lanes.map((other) => (other.target === lane.target ? levelled : other))
        : [...lanes, levelled],
    }),
  }
}
