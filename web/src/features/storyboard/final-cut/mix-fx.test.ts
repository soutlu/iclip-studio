import { serializeAutomation, parseAutomation } from '@hyperframes/core/audio-automation'
import {
  parseAudioFxChain,
  serializeAudioFxChain,
  type HfAudioFxChain,
} from '@hyperframes/core/audio-fx'
import { HF_AUDIO_FX_PRESETS } from '@hyperframes/core/audio-fx-presets'
import { describe, expect, it } from 'vitest'
import type { AudioRole } from './audio-role'
import { CARVE_SAMPLE_RATE, chainOf } from './carve'
import { levellerAttributes } from './leveller'
import {
  eqBandsOf,
  fineTuneSummary,
  fxEditAttributes,
  morePresets,
  ownEffects,
  pitchOf,
  presetAmountOf,
  presetOf,
  quickPresets,
  withEffect,
  withEffectEnabled,
  withEffectParam,
  withEqGain,
  withoutEffect,
  withoutTone,
  withPitch,
  withPreset,
  withPresetAmount,
} from './mix-fx'

/** 前两秒很轻、后面很响的声音：平稳音量会生成节点和曲线。 */
const uneven = Float32Array.from(
  { length: 6 * CARVE_SAMPLE_RATE },
  (_, i) => Math.sin(i / 7) * (i < 2 * CARVE_SAMPLE_RATE ? 0.02 : 0.5),
)

/** 压低生成的一段滤波、平稳音量的节点和曲线、一个自己加的限制器、一段均衡，都在同一条链上。 */
function busyClip() {
  const levelled = levellerAttributes(undefined, undefined, { samples: uneven, rate: 1 })
  const base = chainOf(levelled?.chain ?? undefined)
  const carved: HfAudioFxChain = {
    ...base,
    nodes: [
      { type: 'peaking', id: 'c1', fromCarve: true, params: { frequency: 900, gain: -3, q: 2 } },
      ...base.nodes,
    ],
  }
  const chain = withEqGain(withEffect(carved, 'truepeak'), 'Bass', 3)
  return { chain, automation: levelled?.automation ?? undefined }
}

const types = (chain: HfAudioFxChain) => chain.nodes.map((node) => node.type)

describe('音色风格：单选的预设', () => {
  it('换预设：原来那个的节点去掉，新的放在原来的位置；压低、平稳音量、均衡、自己加的效果都还在', () => {
    const { chain } = busyClip()
    const telephone = withPreset(chain, 'telephone')
    expect(presetOf(telephone)).toBe('telephone')
    const kept = chain.nodes.length
    expect(telephone.nodes).toHaveLength(kept + 7)

    const hall = withPreset(telephone, 'hall')
    expect(presetOf(hall)).toBe('hall')
    expect(hall.nodes.filter((node) => node.fromPreset === 'telephone')).toEqual([])
    // 接在原来电话那段开头的位置，也就是原来的链尾
    expect(hall.nodes.slice(0, kept)).toEqual(chain.nodes)
    expect(hall.nodes.at(-1)).toMatchObject({ type: 'reverb', fromPreset: 'hall' })
    // 新节点的编号不和留着的撞
    expect(new Set(hall.nodes.map((node) => node.id)).size).toBe(hall.nodes.length)

    // 预设后面又加了效果：换预设时新预设留在前面那段的位置
    const after = withEffect(telephone, 'delay')
    const swapped = withPreset(after, 'slap-echo')
    expect(types(swapped).slice(kept)).toEqual(['delay', 'delay'])
    expect(swapped.nodes[kept]).toMatchObject({ fromPreset: 'slap-echo' })
    expect(swapped.nodes.at(-1)?.fromPreset).toBeUndefined()
  })

  it('选「原声」只去掉预设的节点', () => {
    const { chain } = busyClip()
    const original = withPreset(withPreset(chain, 'voice-broadcast'), null)
    expect(original).toEqual(chain)
    expect(presetOf(original)).toBeNull()
  })

  it('混合强度写在预设的每个节点上，没写时是 100%', () => {
    const { chain } = busyClip()
    const preset = withPreset(chain, 'lofi-tape')
    expect(presetAmountOf(preset)).toBe(1)
    const half = withPresetAmount(preset, 0.4)
    expect(presetAmountOf(half)).toBe(0.4)
    for (const node of half.nodes)
      expect(node.presetAmount).toBe(node.fromPreset === undefined ? undefined : 0.4)
  })

  it('快捷小块：人声一组，配乐、音效一组；用着的预设不在里面时换掉最后一个', () => {
    expect(quickPresets('voice', null)).toEqual([
      'voice-clean',
      'rumble-cut',
      'voice-broadcast',
      'harsh-tame',
      'telephone',
    ])
    expect(quickPresets('sfx', null)).toEqual(quickPresets('music', null))
    expect(quickPresets('music', 'hall')).toEqual(quickPresets('music', null))
    expect(quickPresets('music', 'monster').at(-1)).toBe('monster')
  })

  it('更多风格：去掉快捷小块里已有的（连同换进小块的那个），剩下的按类列，空了的类不列', () => {
    const listed = (role: AudioRole, active: string | null) =>
      morePresets(role, active).flatMap(({ ids }) => ids)
    const all = HF_AUDIO_FX_PRESETS.map((preset) => preset.id)
    for (const role of ['voice', 'music'] as const) {
      const tiles = quickPresets(role, null)
      expect(listed(role, null).toSorted()).toEqual(
        all.filter((id) => !tiles.includes(id)).toSorted(),
      )
    }
    expect(listed('music', 'monster')).not.toContain('monster')
    expect(listed('music', 'monster')).toContain('radio-am')
    expect(morePresets('voice', null).every(({ ids }) => ids.length > 0)).toBe(true)
  })
})

describe('三段均衡', () => {
  it('没调过时是三段 0 dB，频率照 core', () => {
    expect(
      eqBandsOf({ version: 1, nodes: [] }).map(({ name, frequency, gain }) => [
        name,
        frequency,
        gain,
      ]),
    ).toEqual([
      ['Bass', 200, 0],
      ['Middle', 1000, 0],
      ['Treble', 4000, 0],
    ])
  })

  it('调一段时加上三段的滤波，读回来是调的值；都回到 0 时整个去掉，别的节点不动', () => {
    const empty: HfAudioFxChain = { version: 1, nodes: [] }
    const mid = withEqGain(empty, 'Middle', -4.5)
    expect(types(mid)).toEqual(['lowshelf', 'peaking', 'highshelf'])
    expect(mid.nodes.every((node) => node.fromEq === 'eq1')).toBe(true)
    expect(eqBandsOf(mid).map((band) => band.gain)).toEqual([0, -4.5, 0])
    // 超出 ±12 dB 的收进来
    expect(eqBandsOf(withEqGain(mid, 'Treble', 30)).at(-1)?.gain).toBe(12)

    const { chain } = busyClip()
    const flat = withEqGain(chain, 'Bass', 0)
    expect(flat.nodes.some((node) => node.fromEq !== undefined)).toBe(false)
    expect(flat.nodes).toEqual(chain.nodes.filter((node) => node.fromEq === undefined))
  })

  it('「归零」去掉均衡和升降调', () => {
    const { chain } = busyClip()
    const tuned = withPitch(withEqGain(chain, 'Treble', 2), 3)
    const reset = withoutTone(tuned)
    expect(eqBandsOf(reset).every((band) => band.gain === 0)).toBe(true)
    expect(pitchOf(reset)).toBe(0)
    expect(reset.nodes).toEqual(chain.nodes.filter((node) => node.fromEq === undefined))
  })
})

describe('升降调', () => {
  it('写成一个不带来源标记的变调节点：已有的原位改，0 时去掉；预设里自带的变调不算', () => {
    const chipmunk = withPreset({ version: 1, nodes: [] }, 'chipmunk')
    expect(pitchOf(chipmunk)).toBe(0)
    const up = withPitch(chipmunk, 3)
    expect(pitchOf(up)).toBe(3)
    expect(up.nodes.at(-1)).toMatchObject({
      type: 'pitchshift',
      enabled: true,
      params: { semitones: 3, mix: 1 },
    })
    expect(up.nodes.at(-1)?.fromPreset).toBeUndefined()
    const down = withPitch(up, -5)
    expect(down.nodes).toHaveLength(up.nodes.length)
    expect(pitchOf(down)).toBe(-5)
    expect(withPitch(down, 0)).toEqual(chipmunk)
  })
})

describe('自己加的效果', () => {
  it('列表里只有自己加的：压低、平稳音量、均衡、预设、升降调的节点都不在', () => {
    const { chain } = busyClip()
    const full = withPitch(withPreset(chain, 'megaphone'), 2)
    expect(ownEffects(full).map((node) => node.type)).toEqual(['truepeak'])
  })

  it('加、开关、改参数、移除；加的时候参数照 core，有一个旋钮管几个参数的取中间档', () => {
    const { chain } = busyClip()
    const added = withEffect(withEffect(chain, 'compressor'), 'lowpass')
    expect(ownEffects(added).map((node) => node.type)).toEqual([
      'truepeak',
      'compressor',
      'lowpass',
    ])
    expect(ownEffects(added)[1]?.params).toMatchObject({ threshold: -21, ratio: 4, knee: 2.83 })
    expect(ownEffects(added)[2]?.params).toEqual({ frequency: 8000, q: 0.707, poles: '2' })

    const off = withEffectEnabled(added, 1, false)
    expect(ownEffects(off)[1]?.enabled).toBe(false)
    expect(ownEffects(withEffectEnabled(off, 1, true))[1]?.enabled).toBe(true)

    const tuned = withEffectParam(added, 2, 'frequency', 1800)
    expect(ownEffects(tuned)[2]?.params).toMatchObject({ frequency: 1800 })
    // 超出范围的按 core 收进来，枚举不认的值用默认
    const clamped = withEffectParam(withEffectParam(tuned, 2, 'frequency', 5), 2, 'poles', '9')
    expect(ownEffects(clamped)[2]?.params).toMatchObject({ frequency: 100, poles: '2' })

    const removed = withoutEffect(tuned, 0)
    expect(ownEffects(removed).map((node) => node.type)).toEqual(['compressor', 'lowpass'])
    // 别的节点一个不少
    expect(removed.nodes).toHaveLength(tuned.nodes.length - 1)
  })
})

describe('写进片段', () => {
  it('去掉的节点、预设的曲线一起去掉，平稳音量的曲线留着；链空了时去掉属性', () => {
    const { chain, automation } = busyClip()
    const [own] = ownEffects(chain)
    const ownLane = { target: `fx.${own?.id ?? ''}.ceiling`, points: [{ t: 0, v: -3 }] }
    const presetLane = { target: 'fx.preset.hall', points: [{ t: 0, v: 0.5 }] }
    const lanes = parseAutomation(automation ?? '').lanes
    const withHall = withPreset(chain, 'hall')
    const before = {
      chain: serializeAudioFxChain(withHall),
      automation: serializeAutomation({ version: 1, lanes: [...lanes, ownLane, presetLane] }),
    }
    const written = fxEditAttributes(before.chain, before.automation, (current) =>
      withPreset(withoutEffect(current, 0), null),
    )
    expect(parseAutomation(written.automation ?? '').lanes).toEqual(lanes)
    expect(ownEffects(parseAudioFxChain(written.chain ?? ''))).toEqual([])

    const cleared = fxEditAttributes(
      serializeAudioFxChain(withEffect({ version: 1, nodes: [] }, 'reverb')),
      undefined,
      (current) => withoutEffect(current, 0),
    )
    expect(cleared).toEqual({ chain: null, automation: null })
  })

  it('「精细调音」的摘要：调了均衡、升降调、开着几个效果；什么都没调是「默认」', () => {
    const empty: HfAudioFxChain = { version: 1, nodes: [] }
    expect(fineTuneSummary(empty)).toBe('默认')
    expect(fineTuneSummary(withPreset(empty, 'hall'))).toBe('默认')
    const tuned = withEffect(
      withEffect(withPitch(withEqGain(empty, 'Bass', 2), -2), 'delay'),
      'reverb',
    )
    expect(fineTuneSummary(tuned)).toBe('均衡 · -2 半音 · 2 个效果')
    expect(fineTuneSummary(withEffectEnabled(tuned, 0, false))).toBe('均衡 · -2 半音 · 1 个效果')
  })
})
