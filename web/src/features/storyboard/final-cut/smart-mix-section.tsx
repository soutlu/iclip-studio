import { useId, useState, type ReactNode } from 'react'
import { DEFAULT_CARVE } from '@hyperframes/core/audio-carve'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { Switch } from '@/shared/ui/switch'
import { AUDIO_ROLES, isAudioRole } from './audio-role'
import { SliderControl } from './inspector-controls'
import { presetAmountOf, presetOf, withPreset, withPresetAmount } from './mix-fx'
import { MixFineTune } from './smart-mix-fine-tune'
import { MixStyle } from './smart-mix-style'
import type { SmartMix } from './use-smart-mix'

// 强度照参照的工作台：0–1，每格 0.05，显示成百分比
const STRENGTH_STEPS = 20
// 预设的混合强度照参照的工作台：0–1，每格 0.01
const PRESET_AMOUNT_STEPS = 100
const strengthText = (strength: number) => `${Math.round(strength * 100)}%`
const PERCENT = /^(\d+(?:\.\d+)?)\s*%?$/

const BUSY_REASON = '正在分析声音，请稍候'

/**
 * 「智能调音」：标题行右边是声音角色（人声、配乐、音效）。人声的主开关是「自动平稳人声音量」，下面一行是
 * 「遇到其他人声时自动压低」；配乐、音效的主开关是「有人说话时自动压低」（开着时下面是压低幅度和压低示意），下面
 * 一行是「同时开启自动平稳音量」。平稳音量只有开关（强度用默认值，照参照的工作台）。拖压低幅度时只动这里，松手
 * （或按一下方向键）才交出去；分析声音期间开关和强度都不能改。
 *
 * 下面是「音色风格」（选了预设时多一条混合强度）和收起的「精细调音」（均衡、升降调、自己加的效果），都直接改
 * 效果链，见 `mix-fx.ts`。
 */
export function SmartMixSection({
  mix,
  onEditing,
}: {
  mix: SmartMix
  onEditing: (editing: boolean) => void
}) {
  const voice = mix.role === 'voice'
  const carveOn = mix.carve?.enabled === true
  const levelOn = mix.levelled
  const blocked = mix.analysing ? BUSY_REASON : undefined
  const roleLabel = AUDIO_ROLES.find((r) => r.role === mix.role)?.label
  const preset = presetOf(mix.chain)
  const carve = (
    <MixHero
      blockedReason={blocked}
      checked={carveOn}
      onChange={mix.setCarveEnabled}
      title="有人说话时自动压低"
    >
      {carveOn ? (
        <CarveStrength
          disabled={mix.analysing}
          onCommit={mix.setCarveStrength}
          onEditing={onEditing}
          strength={mix.carve?.strength ?? DEFAULT_CARVE.strength}
        />
      ) : null}
    </MixHero>
  )
  const leveller = (
    <MixHero
      blockedReason={blocked}
      checked={levelOn}
      onChange={mix.setLevellerEnabled}
      title="自动平稳人声音量"
    />
  )
  return (
    <section className="wf-card wf-prop-card">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title">智能调音</h4>
        {mix.analysing ? (
          <span className="wf-prop-subtitle" role="status">
            正在分析声音
          </span>
        ) : null}
        <MenuRoot>
          <MenuTrigger asChild>
            <button
              aria-label={`角色：${roleLabel ?? ''}`}
              className="wf-select wf-mix-role ui-state ui-focus"
              type="button"
            >
              {roleLabel}
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
      </div>
      {voice ? leveller : carve}
      <ExtraSwitch
        blockedReason={blocked}
        checked={voice ? carveOn : levelOn}
        label={voice ? '遇到其他人声时自动压低' : '同时开启自动平稳音量'}
        onChange={voice ? mix.setCarveEnabled : mix.setLevellerEnabled}
      />
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
    </section>
  )
}

/** 主开关的一块：浅底圆角，标题和开关一行，下面可以再放几行；开着时多一道浮起的高光。 */
function MixHero({
  title,
  checked,
  blockedReason,
  onChange,
  children,
}: {
  title: string
  checked: boolean
  blockedReason: string | undefined
  onChange: (on: boolean) => void
  children?: ReactNode
}) {
  const titleId = useId()
  return (
    <div className={cn('wf-mix-hero', checked && 'is-on')}>
      <div className="wf-prop-title-row">
        <span className="wf-mix-heading" id={titleId}>
          {title}
        </span>
        <span className="wf-prop-title-end">
          <Switch
            aria-labelledby={titleId}
            blockedReason={blockedReason}
            checked={checked}
            onCheckedChange={onChange}
          />
        </span>
      </div>
      {children}
    </div>
  )
}

/** 主开关下面的另一项：名字和开关一行。 */
function ExtraSwitch({
  label,
  checked,
  blockedReason,
  onChange,
}: {
  label: string
  checked: boolean
  blockedReason: string | undefined
  onChange: (on: boolean) => void
}) {
  const labelId = useId()
  return (
    <div className="wf-mix-extra">
      <span className="wf-prop-label" id={labelId}>
        {label}
      </span>
      <Switch
        aria-labelledby={labelId}
        blockedReason={blockedReason}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
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
