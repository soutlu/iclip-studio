import { useId, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { Input } from '@/shared/ui/field'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { Switch } from '@/shared/ui/switch'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { AspectGlyph } from '../components/aspect-glyph'
import { CANVAS_SIZES, canvasLabel, presetOf } from './canvas-size'
import type { Canvas } from './composition/film'
import { Tool } from './editor-toolbar'

/** 构图网格：关闭、九宫格、十字。 */
type FramingGrid = 'off' | 'thirds' | 'cross'

/** 画面上的参考线：只是这次编辑时看的，不写进工程、不进导出。 */
export type Framing = { grid: FramingGrid; safeArea: boolean }

const GRIDS: readonly { grid: FramingGrid; label: string }[] = [
  { grid: 'off', label: '关闭' },
  { grid: 'thirds', label: '九宫格' },
  { grid: 'cross', label: '十字' },
]

// design-allow -- 画布底色是作品内容，写进主文件、导出成片
const [BLACK, SLATE, LINEN, WHITE] = ['#000000', '#4b535c', '#eae2d4', '#ffffff'] as const

/**
 * 「画布底色」能选的颜色。`keyword` 是同一种颜色在主文件里的另一种写法：按模版建的工程 `<head>` 里写的是 black。
 */
const BACKGROUNDS = [
  { name: '纯黑', color: BLACK, keyword: 'black' },
  { name: '岩灰', color: SLATE },
  { name: '暖米', color: LINEN },
  { name: '纯白', color: WHITE, keyword: 'white' },
] as const

const backgroundNamed = (value: string | null) => {
  const written = value?.trim().toLowerCase()
  return BACKGROUNDS.find(
    (each) => each.color === written || ('keyword' in each && each.keyword === written),
  )
}

/** 画面每边能写的像素数。 */
const SIDE_RANGE = { min: 240, max: 4096 } as const
const SIDE_RANGE_TEXT = `宽高要在 ${SIDE_RANGE.min}–${SIDE_RANGE.max} 之间`

/** 框里写的边长：整数，奇数减 1（视频编码要偶数宽高）；不是整数、不在范围里时是 null。 */
const sideOf = (text: string): number | null => {
  const typed = text.trim()
  if (!/^\d+$/.test(typed)) return null
  const value = Number(typed)
  return value < SIDE_RANGE.min || value > SIDE_RANGE.max ? null : value - (value % 2)
}

type Side = 'width' | 'height'

const ratioOf = ({ width, height }: Canvas) => `${width}:${height}`

type CanvasSettingsProps = {
  canvas: Canvas
  /** 把画面尺寸改成 `canvas`，算一步撤销；和现在一样时不算。 */
  onCanvas: (canvas: Canvas) => void
  /** 画面底色；读不出来时是 null（哪个颜色都不按下）。 */
  background: string | null
  /** 把画面底色改成 `color`，算一步撤销。 */
  onBackground: (color: string) => void
  framing: Framing
  onFraming: (framing: Framing) => void
  /**
   * 浮层和提示挂到哪：编辑器根上（浮层里按的键不当快捷键、Esc 只关浮层，见 `isEditorKeyTarget`），全屏时是舞台。
   */
  layer: HTMLElement | null
}

/**
 * 预览舞台右上角的一枚胶囊：左边是画面尺寸（比例小框、简称、⌄），点开是画面设置浮层；右边是参考线的快捷开关，
 * 有参考线开着时全关，全关着时打开九宫格和安全区。
 */
export function CanvasSettings({ framing, onFraming, layer, ...settings }: CanvasSettingsProps) {
  const { canvas } = settings
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const label = canvasLabel(canvas)
  const guided = framing.grid !== 'off' || framing.safeArea
  return (
    <div className="wf-stage-hud">
      <PopupRoot
        onOpenChange={(next) => {
          setOpen(next)
          setHint(false)
        }}
        open={open}
      >
        <TooltipRoot onOpenChange={setHint} open={hint && !open}>
          <PopupTrigger asChild>
            <TooltipTrigger asChild>
              <button
                aria-label={`画面尺寸 ${label}`}
                className="wf-stage-hud-size ui-state ui-focus"
                type="button"
              >
                <AspectGlyph longSide={12} ratio={ratioOf(canvas)} />
                {label}
                <Icon decorative name="final-cut-expand" size="xs" />
              </button>
            </TooltipTrigger>
          </PopupTrigger>
          <TooltipContent className="wf-tip" container={layer} side="bottom">
            画面尺寸 {canvas.width}×{canvas.height}
          </TooltipContent>
        </TooltipRoot>
        <PopupSurface
          align="end"
          aria-label="画面设置"
          className="wf-menu wf-canvas-settings"
          collisionPadding={8}
          container={layer}
          // 数字框里的 Esc 只放弃刚输入的，浮层留着
          onEscapeKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement) event.preventDefault()
          }}
          sideOffset={6}
        >
          <SettingsPanel {...settings} framing={framing} layer={layer} onFraming={onFraming} />
        </PopupSurface>
      </PopupRoot>
      <i aria-hidden="true" className="wf-stage-hud-sep" />
      <Tool
        icon="final-cut-guides"
        label="参考线"
        onClick={() =>
          onFraming(guided ? { grid: 'off', safeArea: false } : { grid: 'thirds', safeArea: true })
        }
        pressed={guided}
        tip={guided ? '关闭参考线' : '打开九宫格和安全区'}
        tipContainer={layer}
      />
    </div>
  )
}

/**
 * 画面设置浮层：六种比例（宽高正好是哪一种时它按下）、宽高数字框和互换宽高、画布底色、构图网格、短视频安全区。
 * 数字框回车或失焦生效，奇数减 1，不是整数、不在范围里时框下面一句提示、框回到原来的值。改尺寸、改底色各算一步撤销。
 */
function SettingsPanel({
  canvas,
  onCanvas,
  background,
  onBackground,
  framing,
  onFraming,
  layer,
}: CanvasSettingsProps) {
  // 刚才没写对的那一边：提示一直留到下一次改成功
  const [invalid, setInvalid] = useState<Side | null>(null)
  const errorId = useId()
  const safeId = useId()
  const resize = (next: Canvas) => {
    setInvalid(null)
    onCanvas(next)
  }
  const preset = presetOf(canvas)
  const shownBackground = backgroundNamed(background)
  const side = (key: Side, label: string) => (
    <SideField
      describedBy={invalid === null ? undefined : errorId}
      invalid={invalid === key}
      label={label}
      onCommit={(text) => {
        const value = sideOf(text)
        if (value === null) setInvalid(key)
        else resize({ ...canvas, [key]: value })
      }}
      value={canvas[key]}
    />
  )
  return (
    <>
      <div aria-label="画面比例" className="wf-canvas-ratios" role="group">
        {CANVAS_SIZES.map((each) => (
          <button
            aria-pressed={each === preset}
            className="wf-canvas-ratio ui-state ui-focus"
            key={each.label}
            onClick={() => resize(each.canvas)}
            type="button"
          >
            <AspectGlyph longSide={12} ratio={ratioOf(each.canvas)} />
            {each.label}
          </button>
        ))}
      </div>
      <hr className="wf-canvas-settings-sep" />
      <div className="wf-prop-field">
        <span className="wf-prop-label">像素尺寸</span>
        <div aria-label="像素尺寸" className="wf-canvas-control wf-canvas-pixels" role="group">
          {side('width', '宽')}
          <Tool
            icon="final-cut-swap"
            label="互换宽高"
            onClick={() => resize({ width: canvas.height, height: canvas.width })}
            tip={`互换宽高（${canvas.height}×${canvas.width}）`}
            tipContainer={layer}
          />
          {side('height', '高')}
        </div>
      </div>
      {invalid === null ? null : (
        <p className="wf-canvas-error" id={errorId} role="alert">
          {SIDE_RANGE_TEXT}
        </p>
      )}
      <div className="wf-prop-field">
        <span className="wf-prop-label">画布底色</span>
        <div aria-label="画布底色" className="wf-canvas-swatches" role="group">
          {shownBackground === undefined ? null : (
            <span className="wf-canvas-swatch-name">{shownBackground.name}</span>
          )}
          {BACKGROUNDS.map((each) => (
            <button
              aria-label={each.name}
              aria-pressed={each === shownBackground}
              className="wf-canvas-swatch ui-focus"
              key={each.color}
              onClick={() => {
                if (each !== shownBackground) onBackground(each.color)
              }}
              // 色点的颜色就是它代表的底色
              style={{ background: each.color }}
              type="button"
            />
          ))}
        </div>
      </div>
      <hr className="wf-canvas-settings-sep" />
      <div className="wf-prop-field">
        <span className="wf-prop-label">构图网格</span>
        <div
          aria-label="构图网格"
          className="wf-seg wf-canvas-control wf-canvas-grids"
          role="group"
        >
          {GRIDS.map(({ grid, label }) => (
            <button
              aria-pressed={framing.grid === grid}
              className="wf-seg-item ui-state ui-focus"
              key={grid}
              onClick={() => onFraming({ ...framing, grid })}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="wf-prop-field">
        <label className="wf-prop-label" htmlFor={safeId}>
          短视频安全区
        </label>
        <Switch
          checked={framing.safeArea}
          id={safeId}
          onCheckedChange={(safeArea) => onFraming({ ...framing, safeArea })}
        />
      </div>
    </>
  )
}

/**
 * 宽或高的数字框：没在输入时写着 `value`。回车或失焦把输入的字交给 `onCommit`，Esc 放弃；交完框里回到 `value`
 * （改成功时就是新的值）。
 */
function SideField({
  label,
  value,
  invalid,
  describedBy,
  onCommit,
}: {
  label: string
  value: number
  invalid: boolean
  describedBy: string | undefined
  onCommit: (text: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // 按 Esc 时先放弃再失焦，失焦的处理读这里，不等重新渲染
  const draftRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }
  return (
    <label className="wf-field wf-canvas-side">
      <span aria-hidden="true">{label}</span>
      <Input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-label={label}
        autoComplete="off"
        className="wf-canvas-side-input"
        inputMode="numeric"
        onBlur={() => {
          const typed = draftRef.current
          edit(null)
          if (typed !== null) onCommit(typed)
        }}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') {
            edit(null)
            event.currentTarget.blur()
          }
        }}
        value={draft ?? String(value)}
      />
    </label>
  )
}

// 宽 / 高不超过这个比例时算竖的或方的画面（安全区按竖屏短视频的样子画）
const UPRIGHT_MAX_RATIO = 1.05

/** 构图网格每个方向上的线画在哪（位置见 final-cut.css 的 wf-framing-line）。 */
const GRID_LINES: Record<FramingGrid, readonly string[]> = {
  off: [],
  thirds: ['third', 'two-thirds'],
  cross: ['half'],
}

/**
 * 盖在预览画面上的参考线（和画面一样大，见 `PreviewPlayer` 的 `overlay`）：构图网格的线，和短视频平台会被界面挡住
 * 的地方。竖的或方的画面是右侧互动区和底部信息区，横的是底部播控区。只画在编辑器里，不接指针。
 */
export function FramingGuides({ canvas, framing }: { canvas: Canvas; framing: Framing }) {
  if (framing.grid === 'off' && !framing.safeArea) return null
  const upright = canvas.width / canvas.height <= UPRIGHT_MAX_RATIO
  return (
    <div aria-hidden="true" className="wf-framing" data-testid="framing-guides">
      {GRID_LINES[framing.grid].flatMap((at) =>
        (['x', 'y'] as const).map((axis) => (
          <i className="wf-framing-line" data-at={at} data-axis={axis} key={`${axis}-${at}`} />
        )),
      )}
      {framing.safeArea ? (
        upright ? (
          <>
            <span className="wf-framing-zone" data-zone="side">
              互动区
            </span>
            <span className="wf-framing-zone" data-zone="bottom">
              底部信息遮挡区
            </span>
          </>
        ) : (
          <span className="wf-framing-zone" data-zone="controls">
            底部播控遮挡区
          </span>
        )
      ) : null}
    </div>
  )
}
