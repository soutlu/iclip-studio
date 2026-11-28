import { useId, useState } from 'react'
import { DEFAULT_CARVE } from '@hyperframes/core/audio-carve'
import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { AUDIO_ROLES, isAudioRole } from './audio-role'
import { SliderControl } from './inspector-controls'
import { presetAmountOf, presetOf, withPreset, withPresetAmount } from './mix-fx'
import { MixFineTune } from './smart-mix-fine-tune'
import { MixStyle } from './smart-mix-style'
import { PropRow, PropSection, PropSwitch } from './ui/prop-layout'
import type { SmartMix } from './use-smart-mix'

// 强度照参照的工作台：0–1，每格 0.05，显示成百分比
const STRENGTH_STEPS = 20
// 预设的混合强度照参照的工作台：0–1，每格 0.01
const PRESET_AMOUNT_STEPS = 100
const strengthText = (strength: number) => `${Math.round(strength * 100)}%`
const PERCENT = /^(\d+(?:\.\d+)?)\s*%?$/

const BUSY_REASON = '正在分析声音，请稍候'

/**
 * 「自动避让」：有别的人声时自动压低这一段（见 `use-smart-mix.ts` 的压低）。配乐、音效开着时下面多一条压低幅度和
 * 压低示意，人声只有开关。拖压低幅度时只动这里，松手（或按一下方向键）才交出去；分析声音期间开关和幅度都不能改。
 */
export function DuckSwitch({
  mix,
  onEditing,
}: {
  mix: SmartMix
  onEditing: (editing: boolean) => void
}) {
  const on = mix.carve?.enabled === true
  return (
    <>
      <PropSwitch
        blockedReason={mix.analysing ? BUSY_REASON : undefined}
        checked={on}
        label="自动避让"
        onChange={mix.setCarveEnabled}
      />
      {on && mix.role !== 'voice' ? (
        <CarveStrength
          disabled={mix.analysing}
          onCommit={mix.setCarveStrength}
          onEditing={onEditing}
          strength={mix.carve?.strength ?? DEFAULT_CARVE.strength}
        />
      ) : null}
    </>
  )
}

/**
 * 「智能调音」：声音角色（人声、配乐、音效）一行；人声先是「自动平稳人声音量」再是「自动避让」，配乐、音效先是
 * 「自动避让」再是「同时开启自动平稳音量」。`withDuck` 为假时不放「自动避让」（配乐片段把它排在最上面）。平稳音量
 * 只有开关（强度用默认值，照参照的工作台）；分析声音期间开关都不能改。
 *
 * 下面是「音色风格」（选了预设时多一条混合强度）和收起的「精细调音」（均衡、升降调、自己加的效果），都直接改
 * 效果链，见 `mix-fx.ts`。
 */
export function SmartMixSection({
  mix,
  withDuck,
  onEditing,
}: {
  mix: SmartMix
  withDuck: boolean
  onEditing: (editing: boolean) => void
}) {
  const voice = mix.role === 'voice'
  const roleId = useId()
  const roleLabel = AUDIO_ROLES.find((r) => r.role === mix.role)?.label
  const preset = presetOf(mix.chain)
  const duck = withDuck ? <DuckSwitch mix={mix} onEditing={onEditing} /> : null
  const leveller = (
    <PropSwitch
      blockedReason={mix.analysing ? BUSY_REASON : undefined}
      checked={mix.levelled}
      label={voice ? '自动平稳人声音量' : '同时开启自动平稳音量'}
      onChange={mix.setLevellerEnabled}
    />
  )
  return (
    <PropSection
      end={
        mix.analysing ? (
          <span className="wf-prop-status" role="status">
            正在分析声音
          </span>
        ) : undefined
      }
      title="智能调音"
    >
      <PropRow htmlFor={roleId} label="角色">
        <MenuRoot>
          <MenuTrigger asChild>
            <button
              aria-label={`角色：${roleLabel ?? ''}`}
              className="wf-prop-well wf-prop-select ui-state ui-focus"
              id={roleId}
              type="button"
            >
              <span className="wf-prop-select-text">{roleLabel}</span>
              <Icon decorative name="final-cut-expand" size="xs" />
            </button>
          </MenuTrigger>
          <MenuSurface align="end" aria-label="声音角色" className="wf-menu w-56">
            <MenuRadioGroup
              onValueChange={(value) => {
                if (isAudioRole(value)) mix.setRole(value)
              }}
              value={mix.role}
            >
              {AUDIO_ROLES.map(({ role, label, description }) => (
                <MenuRadioItem className="h-auto py-1.5" key={role} value={role}>
                  <span className="wf-mix-role-option">
                    <span>{label}</span>
                    <span className="wf-mix-role-description">{description}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>
      </PropRow>
      {voice ? (
        <>
          {leveller}
          {duck}
        </>
      ) : (
        <>
          {duck}
          {leveller}
        </>
      )}
      <MixStyle
        active={preset}
        onPick={(next) => mix.editChain((chain) => withPreset(chain, next))}
        role={mix.role}
      />
      {preset === null ? null : (
        <StrengthSlider
          disabled={false}
          label="混合强度"
          onCommit={(amount) => mix.editChain((chain) => withPresetAmount(chain, amount))}
          onEditing={onEditing}
          steps={PRESET_AMOUNT_STEPS}
          strength={presetAmountOf(mix.chain)}
        />
      )}
      <MixFineTune
        chain={mix.chain}
        envelope={mix.envelope}
        onChange={mix.editChain}
        onEditing={onEditing}
        onEnvelope={mix.setEnvelope}
        onResetEnvelope={mix.resetEnvelope}
      />
    </PropSection>
  )
}

/** 压低幅度：滑杆下面是压低示意，拖动中示意跟着拖到的幅度变。 */
function CarveStrength({
  strength,
  disabled,
  onCommit,
  onEditing,
}: {
  strength: number
  disabled: boolean
  onCommit: (strength: number) => void
  onEditing: (editing: boolean) => void
}) {
  // 拖到的幅度，连同开始拖时的幅度：幅度被撤销、改掉以后不再用它
  const [dragged, setDragged] = useState<{ from: number; to: number } | null>(null)
  const drawn = dragged !== null && dragged.from === strength ? dragged.to : strength
  return (
    <>
      <StrengthSlider
        disabled={disabled}
        label="压低幅度"
        onCommit={(next) => {
          setDragged(null)
          onCommit(next)
        }}
        onDrag={(to) => setDragged({ from: strength, to })}
        onEditing={onEditing}
        strength={strength}
      />
      <DuckStage strength={drawn} />
    </>
  )
}

/** 0–1 的强度，显示成百分比；滑杆分 `steps` 格，拖动中把拖到的强度报给 `onDrag`。 */
function StrengthSlider({
  label,
  strength,
  disabled,
  steps = STRENGTH_STEPS,
  onCommit,
  onDrag,
  onEditing,
}: {
  label: string
  strength: number
  disabled: boolean
  steps?: number
  onCommit: (strength: number) => void
  onDrag?: (strength: number) => void
  onEditing: (editing: boolean) => void
}) {
  return (
    <SliderControl
      disabled={disabled}
      format={(position) => strengthText(position / steps)}
      label={label}
      max={steps}
      min={0}
      onCommit={(position) => onCommit(position / steps)}
      onDrag={(position) => onDrag?.(position / steps)}
      onEditing={onEditing}
      onText={(text) => {
        const typed = PERCENT.exec(text)?.[1]
        if (typed === undefined) return false
        onCommit(Math.min(100, Number(typed)) / 100)
        return true
      }}
      position={Math.round(strength * steps)}
      text={strengthText(strength)}
    />
  )
}

// 压低示意的画布（viewBox）：宽 320、高 54，配乐的电平平时在 15 这一线
const DUCK_WIDTH = 320
const DUCK_HEIGHT = 54
const DUCK_REST = 15
// 两段人声的位置：每段一串柱子（起点、根数），配乐在这两段里压下去
const VOICE_RUNS = [
  { x: 56, bars: 14, phase: 0.48 },
  { x: 198, bars: 11, phase: 0.62 },
] as const
const VOICE_BARS = VOICE_RUNS.flatMap(({ x, bars, phase }) =>
  Array.from({ length: bars }, (_, i) => ({
    x: x + i * 5,
    height: 8 + Math.round(Math.sin(i * phase) * 13 + 6),
  })),
)

// 压满时折线压下去多深
const DUCK_DEPTH = 32

/** 配乐电平的折线：两段人声处按幅度（0–1）压下去。 */
const duckLine = (strength: number) => {
  const r = DUCK_REST
  const y = (r + strength * DUCK_DEPTH).toFixed(1)
  return `M 0 ${r} L 36 ${r} C 46 ${r}, 50 ${y}, 60 ${y} L 122 ${y} C 132 ${y}, 136 ${r}, 146 ${r} L 176 ${r} C 186 ${r}, 190 ${y}, 200 ${y} L 254 ${y} C 264 ${y}, 268 ${r}, 278 ${r} L ${DUCK_WIDTH} ${r}`
}

/**
 * 压低示意：下面一层灰柱是人声，上面一条折线是配乐的电平，人声处按压低幅度压下去。只是示意幅度的大小，不是这段
 * 片段真实的声音；纯装饰，读屏不读。
 */
function DuckStage({ strength }: { strength: number }) {
  const fadeId = useId()
  const line = duckLine(strength)
  return (
    <svg
      aria-hidden="true"
      className="wf-duck"
      preserveAspectRatio="none"
      viewBox={`0 0 ${DUCK_WIDTH} ${DUCK_HEIGHT}`}
    >
      <defs>
        <linearGradient id={fadeId} x1={0} x2={0} y1={0} y2={1}>
          <stop className="wf-duck-fade-top" offset="0%" />
          <stop className="wf-duck-fade-bottom" offset="100%" />
        </linearGradient>
      </defs>
      <g className="wf-duck-voice">
        {VOICE_BARS.map((bar) => (
          <rect
            height={bar.height}
            key={bar.x}
            rx={1.5}
            width={3}
            x={bar.x}
            y={DUCK_HEIGHT - 4 - bar.height}
          />
        ))}
      </g>
      <path
        d={`${line} L ${DUCK_WIDTH} ${DUCK_HEIGHT} L 0 ${DUCK_HEIGHT} Z`}
        fill={`url(#${fadeId})`}
      />
      <path className="wf-duck-line" d={line} />
    </svg>
  )
}
