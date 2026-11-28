import { useId } from 'react'
import { getAudioFxDef, type HfAudioFxChain, type HfAudioFxParam } from '@hyperframes/core/audio-fx'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { Switch } from '@/shared/ui/switch'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { Dropdown } from './content-fields'
import {
  paramAt,
  paramPosition,
  paramPositions,
  paramText,
  parseParamText,
  snapParam,
} from './fx-params'
import { SliderControl } from './inspector-controls'
import {
  ADDABLE_EFFECTS,
  ownEffects,
  withEffect,
  withEffectEnabled,
  withEffectParam,
  withoutEffect,
  type ChainChange,
} from './mix-fx'
import { EFFECT_NAMES } from './mix-fx-names'
import { PropRow, PropSubhead } from './ui/prop-layout'

const effectLabel = (type: string) =>
  EFFECT_NAMES[type]?.label ?? getAudioFxDef(type)?.label ?? type

/**
 * 「串联效果器链」：用户自己加的效果，按加进去的顺序一个一组（序号、名字、开关、移除一行，下面是它的参数）；压低、
 * 平稳音量、均衡、预设、升降调的节点不在这里。小标题右边「+」点开能加的几种。参数照 core 的定义一个个列出来。
 */
export function MixEffects({
  chain,
  onChange,
  onEditing,
}: {
  chain: HfAudioFxChain
  onChange: (change: ChainChange) => void
  onEditing: (editing: boolean) => void
}) {
  const effects = ownEffects(chain)
  return (
    <>
      <PropSubhead
        end={
          <MenuRoot>
            <TooltipRoot>
              <TooltipTrigger asChild>
                <MenuTrigger asChild>
                  <button aria-label="添加效果" className="wf-tool ui-state ui-focus" type="button">
                    <Icon decorative name="final-cut-add" size="sm" />
                  </button>
                </MenuTrigger>
              </TooltipTrigger>
              <TooltipContent className="wf-tip" side="top">
                添加效果
              </TooltipContent>
            </TooltipRoot>
            <MenuSurface align="end" aria-label="添加效果" className="wf-menu wf-mix-menu">
              {ADDABLE_EFFECTS.map((type) => (
                <MenuItem
                  className="h-auto py-1.5"
                  key={type}
                  onSelect={() => onChange((current) => withEffect(current, type))}
                >
                  <span className="wf-mix-role-option">
                    <span>{effectLabel(type)}</span>
                    <span className="wf-mix-role-description">
                      {EFFECT_NAMES[type]?.description}
                    </span>
                  </span>
                </MenuItem>
              ))}
            </MenuSurface>
          </MenuRoot>
        }
        title={
          <>
            串联效果器链 <span className="wf-mix-count">({effects.length})</span>
          </>
        }
      />
      {effects.map((node, index) => {
        const name = effectLabel(node.type)
        const on = node.enabled !== false
        return (
          <div
            aria-label={name}
            className="wf-mix-effect"
            data-off={on ? undefined : ''}
            // 加进来的节点都有编号（core 加节点时就取好）
            key={node.id ?? node.type}
            role="group"
          >
            <div className="wf-mix-effect-head">
              <span aria-hidden="true" className="wf-mix-effect-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="wf-mix-effect-name">{name}</span>
              <Switch
                aria-label={`启用：${name}`}
                checked={on}
                onCheckedChange={(next) =>
                  onChange((current) => withEffectEnabled(current, index, next))
                }
              />
              <IconButton
                label={`移除效果：${name}`}
                name="final-cut-close"
                onClick={() => onChange((current) => withoutEffect(current, index))}
                size="xs"
              />
            </div>
            {(getAudioFxDef(node.type)?.params ?? []).map((param) => (
              <ParamRow
                effect={node.type}
                key={param.key}
                onCommit={(value) =>
                  onChange((current) => withEffectParam(current, index, param.key, value))
                }
                onEditing={onEditing}
                param={param}
                value={node.params?.[param.key] ?? param.default}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

/** 一个参数：数字是一条滑杆（范围、步长、单位照 core），枚举是名字在左、下拉在右的一行。 */
function ParamRow({
  effect,
  param,
  value,
  onCommit,
  onEditing,
}: {
  effect: string
  param: HfAudioFxParam
  value: number | string
  onCommit: (value: number | string) => void
  onEditing: (editing: boolean) => void
}) {
  const id = useId()
  const names = EFFECT_NAMES[effect]
  const label = names?.params[param.key] ?? param.label
  if (param.kind === 'enum') {
    const options = param.options.map((option) => ({
      value: option.value,
      label: names?.options?.[param.key]?.[option.value] ?? option.label,
    }))
    return (
      <PropRow htmlFor={id} label={label}>
        <Dropdown
          id={id}
          label={label}
          onChange={onCommit}
          options={options}
          value={String(value)}
        />
      </PropRow>
    )
  }
  const current = typeof value === 'number' ? value : param.default
  return (
    <SliderControl
      format={(position) => paramText(param, paramAt(param, position))}
      label={label}
      max={paramPositions(param)}
      min={0}
      onCommit={(position) => onCommit(paramAt(param, position))}
      onEditing={onEditing}
      onText={(text) => {
        const typed = parseParamText(text)
        if (typed === null) return false
        onCommit(snapParam(param, typed))
        return true
      }}
      position={paramPosition(param, current)}
      text={paramText(param, current)}
    />
  )
}
