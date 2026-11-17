import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { HexColorPicker } from 'react-colorful'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { toast } from '@/shared/ui/toast'
import './color-picker.css'

// prettier-ignore
// design-allow -- 预设色是给用户挑的、写进作品里的颜色，不随外观变，不能引用颜色变量
const SWATCHES = ['#FFFFFF', '#F5EFE6', '#E4B790', '#FBBF24', '#34D399', '#93C5FD', '#FB7185', '#18191D']

type ColorPickerProps = {
  /** 现在的颜色，`#RRGGBB`。 */
  value: string
  /** 拖方块、色相条或按方向键时报新的颜色（`#RRGGBB`）。 */
  onChange: (hex: string) => void
  /** 松手、方向键抬起、点预设色时报一次最后的颜色（`#RRGGBB`）。 */
  onCommit: (hex: string) => void
  /** 打开取色板的按钮。 */
  children: ReactNode
}

/**
 * 取色板：点 `children` 打开，176px 宽，上面是饱和度与明度的方块，下面是色相条和一排 8 个预设色。浏览器有取色笔
 * （`EyeDropper`）时色相条左边是取色笔按钮，从屏幕上取到的颜色报一次 `onCommit`；没有时不显示这个按钮。
 */
export function ColorPicker({ value, onChange, onCommit, children }: ColorPickerProps) {
  const current = value.toUpperCase()
  return (
    <PopupRoot>
      <PopupTrigger asChild>{children}</PopupTrigger>
      <PopupSurface align="start" aria-label="取色板" className="w-44 p-2" sideOffset={6}>
        <Board onChange={onChange} onCommit={onCommit} value={current} />
        <div className="mt-2 grid grid-cols-8 gap-1">
          {SWATCHES.map((hex) => (
            <button
              aria-label={hex}
              aria-pressed={hex === current}
              className={cn(
                'aspect-square rounded-xs ring-1 ring-outline-variant ui-focus ring-inset',
                hex === current && 'outline outline-offset-1 outline-on-surface',
              )}
              key={hex}
              onClick={() => onCommit(hex)}
              style={{ backgroundColor: hex }}
              type="button"
            />
          ))}
        </div>
      </PopupSurface>
    </PopupRoot>
  )
}

/** 方块和色相条（有取色笔时左边带着它）：拖动中报 `onChange`，松手、方向键抬起、取到色时报 `onCommit`，颜色都换成大写。 */
function Board({ value, onChange, onCommit }: Omit<ColorPickerProps, 'children'>) {
  const ref = useRef<HTMLDivElement>(null)
  // 自带的无障碍名称是英文，换成中文；方块读出来的是现在的颜色
  useLayoutEffect(() => {
    const name = (part: string, label: string, text?: string) => {
      const slider = ref.current?.querySelector(`.react-colorful__${part} [role="slider"]`)
      slider?.setAttribute('aria-label', label)
      if (text !== undefined) slider?.setAttribute('aria-valuetext', text)
    }
    name('saturation', '饱和度与明度', value)
    name('hue', '色相')
  })
  const EyeDropper = eyeDropperOf()
  return (
    <div className={cn('color-picker', EyeDropper !== undefined && 'has-eyedropper')} ref={ref}>
      <HexColorPicker
        color={value}
        onChange={(hex) => onChange(hex.toUpperCase())}
        onChangeEnd={(hex) => onCommit(hex.toUpperCase())}
      />
      {EyeDropper === undefined ? null : (
        <button
          aria-label="从画面取色"
          className="color-picker-eyedropper ui-state ui-focus"
          onClick={() => {
            new EyeDropper()
              .open()
              .then(({ sRGBHex }) => {
                if (HEX.test(sRGBHex)) onCommit(sRGBHex.toUpperCase())
              })
              .catch((error: unknown) => {
                // 按 Esc 不取了
                if (error instanceof DOMException && error.name === 'AbortError') return
                toast.info('取色失败，请重试')
              })
          }}
          type="button"
        >
          <Icon decorative name="eyedropper" size="xs" />
        </button>
      )}
    </div>
  )
}

const HEX = /^#[0-9a-f]{6}$/i

/** 浏览器的取色笔：从屏幕上任何地方（含预览画面）取一个颜色。 */
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> }

/** 浏览器有取色笔时是它；没有时是 undefined，不显示取色笔按钮。 */
const eyeDropperOf = (): EyeDropperConstructor | undefined =>
  (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper
