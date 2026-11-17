import { parseAutomationTarget } from '@hyperframes/core/audio-automation'
import {
  defaultAudioFxParams,
  getAudioFxDef,
  mintAudioFxNodeId,
  normalizeAudioFxParams,
  type HfAudioFxChain,
  type HfAudioFxNode,
} from '@hyperframes/core/audio-fx'
import {
  addAudioEq,
  audioEqIds,
  HF_AUDIO_EQ_3,
  readAudioEqBands,
  removeAudioEq,
  setAudioEqBandGain,
  type HfAudioEqBand,
} from '@hyperframes/core/audio-fx-eq'
import {
  activeAudioFxPresetIds,
  audioFxPresetNodes,
  getAudioFxPreset,
} from '@hyperframes/core/audio-fx-presets'
import { applyAudioFxProfile, getAudioFxProfile } from '@hyperframes/core/audio-fx-profiles'
import type { AudioRole } from './audio-role'
import { automationOf, automationText, chainOf, chainText } from './carve'

/**
 * 「智能调音」里的音色风格、精细调音：都是片段效果链（`data-fx-chain`）上的普通节点，写法照 core：
 * - 音色风格是 core 的预设（`@hyperframes/core/audio-fx-presets`），节点带 `fromPreset`（预设的编号），
 *   混合强度是这几个节点上的 `presetAmount`（0–1，没写是 1）。这里只留一个：换预设时去掉原来的，新的放在原来
 *   那段的位置。
 * - 三段均衡是 core 的 `HF_AUDIO_EQ_3`（几个带 `fromEq` 的滤波节点），全都归零时去掉。
 * - 升降调是一个不带任何来源标记的 `pitchshift` 节点，0 半音时去掉；预设里自带的变调节点不算。
 * - 效果是用户自己加的节点：不是压低、平稳音量、均衡、预设生成的，也不是升降调的那个。
 * 压低、平稳音量生成的节点和曲线都留着不动。
 */

/** 改效果链的一步：拿现在的链，给出改好的链。 */
export type ChainChange = (chain: HfAudioFxChain) => HfAudioFxChain

const withNodes = (chain: HfAudioFxChain, nodes: HfAudioFxNode[]): HfAudioFxChain => ({
  ...chain,
  nodes,
})

/** 链上现在的预设编号；没有时是 null（「原声」）。 */
export const presetOf = (chain: HfAudioFxChain): string | null =>
  activeAudioFxPresetIds(chain)[0] ?? null

/**
 * 换成预设 `presetId`（null 是「原声」）：先去掉所有预设带来的节点，再把新预设的节点放在原来那段开头的位置
 * （原来没有预设时接在链尾，照 core 的 `applyAudioFxPreset`）。别的节点都不动。
 */
export function withPreset(chain: HfAudioFxChain, presetId: string | null): HfAudioFxChain {
  const at = chain.nodes.findIndex((node) => node.fromPreset !== undefined)
  const kept = chain.nodes.filter((node) => node.fromPreset === undefined)
  const preset = presetId === null ? undefined : getAudioFxPreset(presetId)
  if (preset === undefined) return withNodes(chain, kept)
  const made = audioFxPresetNodes(preset, withNodes(chain, kept))
  const cut = at < 0 ? kept.length : at
  return withNodes(chain, [...kept.slice(0, cut), ...made, ...kept.slice(cut)])
}

/** 预设的混合强度（0–1）：预设第一个节点上的 `presetAmount`，没写是 1。 */
export const presetAmountOf = (chain: HfAudioFxChain): number =>
  chain.nodes.find((node) => node.fromPreset !== undefined)?.presetAmount ?? 1

/** 把预设的每个节点的混合强度都写成 `amount`。 */
export const withPresetAmount = (chain: HfAudioFxChain, amount: number): HfAudioFxChain =>
  withNodes(
    chain,
    chain.nodes.map((node) =>
      node.fromPreset === undefined ? node : { ...node, presetAmount: amount },
    ),
  )

/** 快捷小块里「原声」后面的五个预设：人声一组，配乐、音效一组（人声那组是修人声的）。 */
const QUICK_PRESETS: Record<AudioRole, readonly string[]> = {
  voice: ['voice-clean', 'rumble-cut', 'voice-broadcast', 'harsh-tame', 'telephone'],
  music: ['room-natural', 'lofi-tape', 'hall', 'slap-echo', 'radio-am'],
  sfx: ['room-natural', 'lofi-tape', 'hall', 'slap-echo', 'radio-am'],
}

/** 角色 `role` 的五个快捷预设；现在用的预设 `active` 不在里面时换掉最后一个。 */
export function quickPresets(role: AudioRole, active: string | null): string[] {
  const ids = [...QUICK_PRESETS[role]]
  if (active !== null && !ids.includes(active)) ids[ids.length - 1] = active
  return ids
}

/** 三段均衡现在的样子（低、中、高）：没加过时是 core 的三段、都是 0。 */
export function eqBandsOf(chain: HfAudioFxChain): HfAudioEqBand[] {
  const [eq] = audioEqIds(chain)
  return eq === undefined ? [...HF_AUDIO_EQ_3] : readAudioEqBands(chain, eq)
}

const isFlat = (bands: readonly HfAudioEqBand[]) => bands.every((band) => band.gain === 0)

/** 把均衡里叫 `band` 的那一段调到 `gain` dB；还没有均衡时先加上（接在链尾），三段都回到 0 时整个去掉。 */
export function withEqGain(chain: HfAudioFxChain, band: string, gain: number): HfAudioFxChain {
  const [known] = audioEqIds(chain)
  const added = known === undefined ? addAudioEq(chain, HF_AUDIO_EQ_3) : { chain, eqId: known }
  const next = setAudioEqBandGain(added.chain, added.eqId, band, gain)
  return isFlat(readAudioEqBands(next, added.eqId)) ? removeAudioEq(next, added.eqId) : next
}

const semitonesParam = getAudioFxDef('pitchshift')?.params.find(
  (param) => param.key === 'semitones',
)

/** 升降调最多升、降几个半音（core 变调效果的范围）。 */
export const PITCH_RANGE = semitonesParam?.kind === 'number' ? semitonesParam.max : 0

/** 升降调的节点：不带任何来源标记的变调节点（预设里自带的不算）。 */
const isPitchNode = (node: HfAudioFxNode) =>
  node.type === 'pitchshift' &&
  node.fromPreset === undefined &&
  node.fromEq === undefined &&
  node.fromCarve !== true &&
  node.fromLeveller !== true

const semitonesOf = (node: HfAudioFxNode) => {
  const value = node.params?.['semitones']
  return typeof value === 'number' ? value : 0
}

/** 升降了几个半音；没有时是 0。 */
export const pitchOf = (chain: HfAudioFxChain): number => {
  const node = chain.nodes.find(isPitchNode)
  return node === undefined ? 0 : semitonesOf(node)
}

/** 升降 `semitones` 个半音：已有的节点原位改，没有时接在链尾，0 时去掉。 */
export function withPitch(chain: HfAudioFxChain, semitones: number): HfAudioFxChain {
  if (semitones === 0)
    return withNodes(
      chain,
      chain.nodes.filter((node) => !isPitchNode(node)),
    )
  const params = (node?: HfAudioFxNode) =>
    normalizeAudioFxParams('pitchshift', { ...node?.params, semitones })
  if (chain.nodes.some(isPitchNode))
    return withNodes(
      chain,
      chain.nodes.map((node) => (isPitchNode(node) ? { ...node, params: params(node) } : node)),
    )
  const node = { type: 'pitchshift', id: mintAudioFxNodeId(chain), enabled: true, params: params() }
  return withNodes(chain, [...chain.nodes, node])
}

/** 「归零」：去掉均衡和升降调。 */
export const withoutTone = (chain: HfAudioFxChain): HfAudioFxChain =>
  withPitch(
    audioEqIds(chain).reduce((next, eq) => removeAudioEq(next, eq), chain),
    0,
  )

/** 用户自己加的效果：不是压低、平稳音量、均衡、预设生成的，也不是升降调的节点。 */
const isOwnEffect = (node: HfAudioFxNode): boolean =>
  node.fromCarve !== true &&
  node.fromLeveller !== true &&
  node.fromEq === undefined &&
  node.fromPreset === undefined &&
  !isPitchNode(node)

/** 用户自己加的效果，按链上的先后。改、删时用它在这里的序号。 */
export const ownEffects = (chain: HfAudioFxChain): HfAudioFxNode[] =>
  chain.nodes.filter(isOwnEffect)

/** 「添加效果」里能加的效果，照这个顺序列。 */
export const ADDABLE_EFFECTS = [
  'highpass',
  'compressor',
  'reverb',
  'delay',
  'saturate',
  'lowpass',
  'truepeak',
] as const

/**
 * 在链尾加一个 `type` 效果。参数照参照的工作台：有「一个旋钮管几个参数」的（压缩、饱和、混响等）取它的中间
 * 档，别的用默认值。
 */
export function withEffect(chain: HfAudioFxChain, type: string): HfAudioFxChain {
  const params = getAudioFxProfile(type)
    ? applyAudioFxProfile(type, 0.5, defaultAudioFxParams(type))
    : defaultAudioFxParams(type)
  const node = { type, id: mintAudioFxNodeId(chain), enabled: true, params }
  return withNodes(chain, [...chain.nodes, node])
}

/** 改第 `index` 个自己加的效果（序号见 `ownEffects`）。 */
const withOwn = (
  chain: HfAudioFxChain,
  index: number,
  change: (node: HfAudioFxNode) => HfAudioFxNode | null,
): HfAudioFxChain => {
  let seen = -1
  const nodes = chain.nodes.flatMap((node) => {
    if (!isOwnEffect(node)) return [node]
    seen += 1
    if (seen !== index) return [node]
    const changed = change(node)
    return changed === null ? [] : [changed]
  })
  return withNodes(chain, nodes)
}

/** 打开或关掉第 `index` 个自己加的效果（关掉是 `enabled: false`）。 */
export const withEffectEnabled = (chain: HfAudioFxChain, index: number, on: boolean) =>
  withOwn(chain, index, (node) => ({ ...node, enabled: on }))

/** 把第 `index` 个自己加的效果的参数 `key` 改成 `value`（超出范围的按 core 收进范围）。 */
export const withEffectParam = (
  chain: HfAudioFxChain,
  index: number,
  key: string,
  value: number | string,
) =>
  withOwn(chain, index, (node) => ({
    ...node,
    params: normalizeAudioFxParams(node.type, { ...node.params, [key]: value }),
  }))

/** 移除第 `index` 个自己加的效果。 */
export const withoutEffect = (chain: HfAudioFxChain, index: number) =>
  withOwn(chain, index, () => null)

/** 「精细调音」收起时右边的摘要，比如「均衡 · +3 半音 · 2 个效果」；什么都没调时是「默认」（照原型）。 */
export function fineTuneSummary(chain: HfAudioFxChain): string {
  const parts: string[] = []
  if (!isFlat(eqBandsOf(chain))) parts.push('均衡')
  const pitch = pitchOf(chain)
  if (pitch !== 0) parts.push(`${pitch > 0 ? '+' : ''}${pitch} 半音`)
  const effects = ownEffects(chain).filter((node) => node.enabled !== false).length
  if (effects > 0) parts.push(`${effects} 个效果`)
  return parts.length > 0 ? parts.join(' · ') : '默认'
}

/**
 * 片段上的效果链 `chain`、曲线 `automation`（属性原来的值）按 `change` 改了以后要写的值（null 是去掉这个属性）。
 * 去掉的节点、预设的曲线一起去掉（照参照的工作台：节点编号按最小的空号取，留着的曲线会被下一个加进来的节点接上）。
 */
export function fxEditAttributes(
  chain: string | undefined,
  automation: string | undefined,
  change: ChainChange,
): { chain: string | null; automation: string | null } {
  const before = chainOf(chain)
  const next = change(before)
  const kept = new Set(next.nodes.map((node) => node.id))
  const gone = new Set(
    before.nodes.flatMap((node) => (node.id === undefined || kept.has(node.id) ? [] : [node.id])),
  )
  const presets = new Set(activeAudioFxPresetIds(next))
  const lanes = automationOf(automation).lanes.filter((lane) => {
    const target = parseAutomationTarget(lane.target)
    if (target?.kind === 'fx') return !gone.has(target.nodeId)
    if (target?.kind === 'preset') return presets.has(target.presetId)
    return true
  })
  return { chain: chainText(next), automation: automationText({ version: 1, lanes }) }
}
