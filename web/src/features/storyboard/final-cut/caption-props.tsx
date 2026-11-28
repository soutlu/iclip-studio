import { useId } from 'react'
import type { ComponentCatalog } from './composition/catalog'
import {
  captionFontSize,
  captionFontSizeRange,
  captionLook,
  NO_CAPTION_STYLE,
  ownsStyle,
  type CaptionStyle,
} from './composition/captions'
import type { Canvas, CaptionClip } from './composition/film'
import { CaptionTextField, type CaptionTextChange } from './captions-tab'
import { ColorField, Dropdown, HEX_COLOR, LocaleChip } from './content-fields'
import { SliderControl } from './inspector-controls'
import type { ShownLocale } from './locales'
import { PropRow, PropSection, PropSwitch } from './ui/prop-layout'

export type CaptionStyleChange = (id: string, changes: Partial<CaptionStyle>) => void

/** 字幕的「内容」：当前展示语言下的字幕文本（与「字幕」页签共用输入框），小标题右边是显示着的语言。 */
export function CaptionContent({
  clip,
  locale,
  onLocale,
  onText,
}: {
  clip: CaptionClip
  locale: ShownLocale
  onLocale: () => void
  onText: CaptionTextChange
}) {
  return (
    <PropSection end={<LocaleChip locale={locale.code} onLocale={onLocale} />} title="内容">
      <CaptionTextField
        aria-label="内容"
        caption={clip}
        className="wf-field wf-prop-textarea"
        key={locale.code}
        locale={locale}
        onText={onText}
      />
    </PropSection>
  )
}

/**
 * 「字幕样式」：字体、字号、颜色三行，最后是「单独设置」开关（各项修改各记一步撤销）。开关关着时三行是字幕样式的生效值，
 * 改的是字幕样式，没单独设置的句子一起变；开着时三行是这一句自己的值，只改这一句。两种状态样子一样，只是改的对象
 * 不同。字号的默认刻度和双击恢复都指默认规则的字号。
 */
export function CaptionStyleRows({
  clip,
  style,
  catalog,
  canvas,
  fonts,
  onStyle,
  onTrackStyle,
  onOwn,
  onEditing,
}: {
  clip: CaptionClip
  style: CaptionStyle
  catalog: ComponentCatalog
  canvas: Canvas
  fonts: readonly string[]
  onStyle: CaptionStyleChange
  onTrackStyle: (changes: Partial<CaptionStyle>) => void
  onOwn: (id: string, own: boolean) => void
  onEditing: (editing: boolean) => void
}) {
  const fontId = useId()
  const colorId = useId()
  const own = ownsStyle(clip)
  const look = captionLook(own ? clip : NO_CAPTION_STYLE, style, catalog, canvas)
  const fallback = captionFontSize(canvas)
  return (
    <PropSection title="字幕样式">
      <PropRow htmlFor={fontId} label="字体">
        <Dropdown
          id={fontId}
          label="字体"
          onChange={(font) => {
            // 单独设置时「默认」也写明中文字体族，这一句才不跟着字幕样式的字体变
            if (own) onStyle(clip.id, { font: font === '' ? catalog.cjk.family : font })
            else onTrackStyle({ font: font === '' ? null : font })
          }}
          options={[
            { value: '', label: '默认' },
            ...fonts.map((font) => ({ value: font, label: font })),
          ]}
          // 中文字体族和不在组件库可选列表中的字体名都展示为「默认」
          value={fonts.includes(look.font) ? look.font : ''}
        />
      </PropRow>
      <CaptionFontSize
        canvas={canvas}
        onChange={(fontSize) => {
          if (own) onStyle(clip.id, { fontSize })
          else onTrackStyle({ fontSize: fontSize === fallback ? null : fontSize })
        }}
        onEditing={onEditing}
        size={look.fontSize}
      />
      <PropRow htmlFor={colorId} label="颜色">
        <ColorField
          complete={(value) => HEX_COLOR.test(value)}
          current={look.color}
          id={colorId}
          label="颜色"
          onChange={(color) => {
            if (own) onStyle(clip.id, { color })
            else onTrackStyle({ color })
          }}
        />
      </PropRow>
      <PropSwitch checked={own} label="单独设置" onChange={(next) => onOwn(clip.id, next)} />
    </PropSection>
  )
}

const pixelsText = (size: number) => `${size} px`

/**
 * 「字号」滑杆：范围为默认字号的 0.5–2 倍，默认规则的字号处标注刻度，双击回到它。超出范围的输入自动钳制。
 */
function CaptionFontSize({
  canvas,
  size,
  onChange,
  onEditing,
}: {
  canvas: Canvas
  /** 现在显示的字号。 */
  size: number
  onChange: (size: number) => void
  onEditing: (editing: boolean) => void
}) {
  const fallback = captionFontSize(canvas)
  const { min, max } = captionFontSizeRange(canvas)
  const write = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next))))
  return (
    <SliderControl
      format={pixelsText}
      label="字号"
      mark={fallback}
      max={max}
      min={min}
      onCommit={write}
      onDoubleClick={() => onChange(fallback)}
      onEditing={onEditing}
      onText={(text) => {
        const typed = Number(text.replace(/px$/i, '').trim())
        if (text === '' || !Number.isFinite(typed)) return false
        write(typed)
        return true
      }}
      position={size}
      text={pixelsText(size)}
    />
  )
}
