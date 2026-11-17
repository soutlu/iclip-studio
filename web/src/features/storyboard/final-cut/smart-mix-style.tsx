import { useId } from 'react'
import {
  audioFxPresetsByFamily,
  HF_AUDIO_FX_PRESET_FAMILIES,
  HF_AUDIO_FX_PRESETS,
} from '@hyperframes/core/audio-fx-presets'
import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/icons'
import {
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import type { AudioRole } from './audio-role'
import { PRESET_FAMILY_NAMES, PRESET_NAMES } from './mix-fx-names'
import { quickPresets } from './mix-fx'

// 菜单的单选值要是文字：「原声」用一个不会是预设编号的值
const ORIGINAL = ''

const presetLabel = (id: string) => PRESET_NAMES[id]?.label ?? id

/**
 * 「音色风格」：一排快捷小块（「原声」加这个角色常用的五个预设），右上「全部预设 (N)」点开按四类列出所有预设。
 * 单选，现在选中的是 `active`（null 是「原声」），选了交给 `onPick`。
 */
export function MixStyle({
  role,
  active,
  onPick,
}: {
  role: AudioRole
  active: string | null
  onPick: (preset: string | null) => void
}) {
  const labelId = useId()
  const tiles = [null, ...quickPresets(role, active)]
  return (
    <div className="wf-mix-block">
      <div className="wf-mix-block-head">
        <span className="wf-mix-block-label" id={labelId}>
          音色风格
        </span>
        <MenuRoot>
          <MenuTrigger asChild>
            <button className="wf-mix-more ui-state ui-focus" type="button">
              全部预设 ({HF_AUDIO_FX_PRESETS.length})
              <Icon decorative name="expand" size="xs" />
            </button>
          </MenuTrigger>
          <MenuSurface align="end" aria-label="全部预设" className="wf-mix-menu">
            <MenuRadioGroup
              onValueChange={(value) => onPick(value === ORIGINAL ? null : value)}
              value={active ?? ORIGINAL}
            >
              <MenuRadioItem value={ORIGINAL}>原声（无风格预设）</MenuRadioItem>
              {HF_AUDIO_FX_PRESET_FAMILIES.map((family) => (
                <div
                  aria-label={PRESET_FAMILY_NAMES[family]}
                  className="contents"
                  key={family}
                  role="group"
                >
                  <MenuSeparator />
                  <div aria-hidden className="wf-mix-menu-label">
                    {PRESET_FAMILY_NAMES[family]}
                  </div>
                  {audioFxPresetsByFamily(family).map((preset) => (
                    <MenuRadioItem className="h-auto py-1.5" key={preset.id} value={preset.id}>
                      <span className="wf-mix-role-option">
                        <span>{presetLabel(preset.id)}</span>
                        <span className="wf-mix-role-description">
                          {PRESET_NAMES[preset.id]?.description}
                        </span>
                      </span>
                    </MenuRadioItem>
                  ))}
                </div>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>
      </div>
      <div aria-labelledby={labelId} className="wf-mix-tiles" role="radiogroup">
        {tiles.map((id) => {
          const checked = id === active
          return (
            <button
              aria-checked={checked}
              className={cn('wf-mix-tile ui-state ui-focus', checked && 'is-active')}
              key={id ?? ORIGINAL}
              onClick={() => {
                if (!checked) onPick(id)
              }}
              role="radio"
              type="button"
            >
              {id === null ? '原声' : presetLabel(id)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
