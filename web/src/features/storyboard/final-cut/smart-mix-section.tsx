import { useId, type ReactNode } from 'react'
import { DEFAULT_CARVE } from '@hyperframes/core/audio-carve'
import { Icon } from '@/shared/icons'
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
 * 「遇到其他人声时自动压低」；配乐、音效的主开关是「有人说话时自动压低」（开着时下面是压低幅度），下面一行是
 * 「同时开启自动平稳音量」。平稳音量只有开关（强度用默认值，照参照的工作台）。拖压低幅度时只动这里，松手（或按
 * 一下方向键）才交出去；分析声音期间开关和强度都不能改。
 *
 * 下面是「音色风格」（选了预设时多一行混合强度）和收起的「精细调音」（均衡、升降调、自己加的效果），都直接改
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
    <MixCard
      blockedReason={blocked}
      checked={carveOn}
      onChange={mix.setCarveEnabled}
      title="有人说话时自动压低"
    >
      {carveOn ? (
        <StrengthRow
          disabled={mix.analysing}
          label="压低幅度"
          onCommit={mix.setCarveStrength}
          onEditing={onEditing}
          strength={mix.carve?.strength ?? DEFAULT_CARVE.strength}
        />
      ) : null}
    </MixCard>
  )
  const leveller = (
    <MixCard
      blockedReason={blocked}
      checked={levelOn}
      onChange={mix.setLevellerEnabled}
      title="自动平稳人声音量"
    />
  )
  return (
    <section className="wf-prop-section">
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
              className="wf-mix-role ui-state ui-focus"
              type="button"
            >
              <span className="wf-mix-role-name">角色：</span>
              {roleLabel}
              <Icon decorative name="expand" size="sm" />
            </button>
          </MenuTrigger>
          <MenuSurface align="end" aria-label="声音角色" className="w-56">
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
        <StrengthRow
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

/** 主开关的一块：浅底圆角，标题和开关一行，下面可以再放几行。 */
function MixCard({
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
    <div className="wf-mix-card">
      <div className="wf-prop-title-row">
        <span className="wf-mix-card-title" id={titleId}>
          {title}
        </span>
        <span className="wf-prop-switch">
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
      <span id={labelId}>{label}</span>
      <Switch
        aria-labelledby={labelId}
        blockedReason={blockedReason}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  )
}

/** 0–1 的强度，显示成百分比；滑杆分 `steps` 格。 */
function StrengthRow({
  label,
  strength,
  disabled,
  steps = STRENGTH_STEPS,
  onCommit,
  onEditing,
}: {
  label: string
  strength: number
  disabled: boolean
  steps?: number
  onCommit: (strength: number) => void
  onEditing: (editing: boolean) => void
}) {
  return (
    <div className="wf-prop-row is-content" data-disabled={disabled || undefined}>
      <span className="wf-prop-label">{label}</span>
      <SliderControl
        disabled={disabled}
        format={(position) => strengthText(position / steps)}
        label={label}
        max={steps}
        min={0}
        onCommit={(position) => onCommit(position / steps)}
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
    </div>
  )
}
