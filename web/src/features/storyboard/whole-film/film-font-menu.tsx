/** 字幕轨的字体选择统一作用于整片；默认字体不需要品牌资源。 */
import type { BrandTemplate } from '@/shared/api/brand-templates'
import { Icon } from '@/shared/icons'
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import type { FilmFont } from './film-draft'

type Props = {
  font: FilmFont | null | undefined
  fonts: readonly BrandTemplate[]
  reason: string | undefined
  retry: (() => void) | undefined
  onSelect: (font: FilmFont | null) => void
}

export function FilmFontMenu({ font, fonts, reason, retry, onSelect }: Props) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label={`字幕字体：${font?.name ?? '系统默认'}`}
          className="film-timeline-head-add ui-state ui-focus"
          type="button"
        >
          <Icon decorative name="settings" size="xs" />
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="film-menu-panel" side="top">
        <p className="film-menu-head">字幕字体 · 应用于全部字幕</p>
        <MenuRadioGroup
          value={font?.fontId ?? ''}
          onValueChange={(id) => {
            const selected = fonts.find((item) => item.id === id)
            if (id === '') onSelect(null)
            else if (selected !== undefined)
              onSelect({ fontId: selected.id, name: selected.name, url: selected.url })
          }}
        >
          <MenuRadioItem value="">系统默认</MenuRadioItem>
          {fonts.map((item) => (
            <MenuRadioItem key={item.id} value={item.id}>
              {item.name}
              {item.brand === null ? '' : ` · ${item.brand}`}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {reason === undefined ? null : <p className="film-menu-empty">{reason}</p>}
        {retry === undefined ? null : <MenuItem onSelect={retry}>重试读取字体</MenuItem>}
      </MenuSurface>
    </MenuRoot>
  )
}
