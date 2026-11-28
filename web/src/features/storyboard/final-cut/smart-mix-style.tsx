import { useId } from 'react'
import { cn } from '@/shared/lib/utils'
import { Icon, type IconName } from '@/shared/icons'
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
import { morePresets, quickPresets } from './mix-fx'
import { PropRow } from './ui/prop-layout'

// 菜单的单选值要是文字：「原声」用一个不会是预设编号的值
const ORIGINAL = ''

const presetLabel = (id: string) => PRESET_NAMES[id]?.label ?? id

// 快捷小块上的图标：有专门图形的预设用自己的，别的和「原声」一样画一条声波
const PRESET_ICONS: Readonly<Record<string, IconName>> = {
  'lofi-tape': 'final-cut-preset-lofi-tape',
  'room-natural': 'final-cut-preset-room-natural',
  'room-tight': 'final-cut-preset-room-tight',
  'rumble-cut': 'final-cut-preset-rumble-cut',
  'harsh-tame': 'final-cut-preset-harsh-tame',
  'voice-clean': 'final-cut-voice',
  'voice-broadcast': 'final-cut-preset-voice-broadcast',
  'voice-warm': 'final-cut-preset-voice-warm',
  hall: 'final-cut-preset-hall',
  'slap-echo': 'final-cut-preset-slap-echo',
}

const presetIcon = (id: string | null): IconName =>
  (id === null ? undefined : PRESET_ICONS[id]) ?? 'final-cut-preset-original'

/**
 * 「音色风格」：三列快捷小块（「原声」加这个角色常用的五个预设，图标加名字），右上「更多风格」点开按四类列出
 * 小块里没有的预设，向上展开。单选，现在选中的是 `active`（null 是「原声」），选了交给 `onPick`。
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
    <PropRow
      end={
        <MenuRoot>
          <MenuTrigger asChild>
            <button className="wf-chip-btn wf-mix-more ui-state ui-focus" type="button">
              更多风格
              <Icon decorative name="final-cut-expand" size="xs" />
            </button>
          </MenuTrigger>
          <MenuSurface align="end" aria-label="更多风格" className="wf-menu wf-mix-menu" side="top">
            {/* 小块里的都不在这里，单选的值仍是现在的预设：选中的那个在小块上 */}
            <MenuRadioGroup onValueChange={onPick} value={active ?? ORIGINAL}>
              {morePresets(role, active).map(({ family, ids }, index) => (
                <div
                  aria-label={PRESET_FAMILY_NAMES[family]}
                  className="contents"
                  key={family}
                  role="group"
                >
                  {index > 0 ? <MenuSeparator /> : null}
                  <div aria-hidden className="wf-mix-menu-label">
                    {PRESET_FAMILY_NAMES[family]}
                  </div>
                  {ids.map((id) => (
                    <MenuRadioItem className="h-auto py-1.5" key={id} value={id}>
                      <span className="wf-mix-role-option">
                        <span>{presetLabel(id)}</span>
                        <span className="wf-mix-role-description">
                          {PRESET_NAMES[id]?.description}
                        </span>
                      </span>
                    </MenuRadioItem>
                  ))}
                </div>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>
      }
      label="音色风格"
      labelId={labelId}
      stacked
    >
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
              <Icon decorative name={presetIcon(id)} size="sm" />
              <span className="wf-mix-tile-name">{id === null ? '原声' : presetLabel(id)}</span>
            </button>
          )
        })}
      </div>
    </PropRow>
  )
}
