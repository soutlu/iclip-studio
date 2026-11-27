import { useId, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { Input } from '@/shared/ui/field'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { Switch } from '@/shared/ui/switch'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { AspectGlyph } from '../components/aspect-glyph'
import { BlockedReason } from '../components/blocked-reason'
import { CANVAS_SIZES, canvasLabel, presetOf } from './canvas-size'
import {
  EXPORT_TIERS,
  tierLabel,
  tierUnsupportedText,
  type ExportTier,
} from './composition/export-resolution'
import type { Canvas } from './composition/film'
import { Tool } from './editor-toolbar'
import { exportOutput } from './export-tier'

/** 构图网格模式：关闭、九宫格、十字。 */
type FramingGrid = 'off' | 'thirds' | 'cross'

/** 画面参考线配置：仅在编辑态展示，不写入工程文件，也不参与成片导出。 */
export type Framing = { grid: FramingGrid; safeArea: boolean }

const GRIDS: readonly { grid: FramingGrid; label: string }[] = [
  { grid: 'off', label: '关闭' },
  { grid: 'thirds', label: '九宫格' },
  { grid: 'cross', label: '十字' },
]

// design-allow -- 画布底色属于作品内容，写入工程主文件并参与成片导出
const [BLACK, SLATE, LINEN, WHITE] = ['#000000', '#4b535c', '#eae2d4', '#ffffff'] as const

/**
 * 可选画布底色。`keyword` 为主文件中的等价 CSS 关键字写法（按默认模板创建的工程在 `<head>` 中写作 `black`）。
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

/** 画面单边允许的像素范围。 */
const SIDE_RANGE = { min: 240, max: 4096 } as const
const SIDE_RANGE_TEXT = `宽高须在 ${SIDE_RANGE.min}–${SIDE_RANGE.max} 之间`

/** 解析输入的边长像素值：须为范围内整数，奇数向下取偶（适配视频编码偶数宽高要求）；非法时返回 `null`。 */
const sideOf = (text: string): number | null => {
  const typed = text.trim()
  if (!/^\d+$/.test(typed)) return null
  const value = Number(typed)
  return value < SIDE_RANGE.min || value > SIDE_RANGE.max ? null : value - (value % 2)
}

type Side = 'width' | 'height'

/** 固定宽度的画面比例缩略框，确保胶囊与六种预设比例后的文字左缘对齐。 */
const RatioGlyph = ({ canvas: { width, height } }: { canvas: Canvas }) => (
  <span className="wf-ratio-glyph">
    <AspectGlyph longSide={12} ratio={`${width}:${height}`} />
  </span>
)

const sizeText = ({ width, height }: Canvas) => `${width}×${height}`

type CanvasSettingsProps = {
  canvas: Canvas
  /** 修改画面尺寸并记为一步撤销；与当前尺寸相同时不记录。 */
  onCanvas: (canvas: Canvas) => void
  /** 当前激活的导出分辨率档位（见 `exportTierOf`）；无匹配档位时为 `undefined`。 */
  tier: ExportTier | undefined
  /** 选择导出分辨率档位（不修改画面尺寸，不计入撤销栈）。 */
  onTier: (tier: ExportTier) => void
  /** 当前画布底色；无法解析时为 `null`（不选中任何色块）。 */
  background: string | null
  /** 修改画布底色并记为一步撤销。 */
  onBackground: (color: string) => void
  framing: Framing
  onFraming: (framing: Framing) => void
  /**
   * 浮层与提示的挂载容器：默认挂至编辑器根节点（避免浮层内按键触发全局快捷键、确保 Esc 仅关闭浮层，见 `isEditorKeyTarget`），全屏模式下挂至舞台节点。
   */
  layer: HTMLElement | null
}

/**
 * 预览舞台右上角的画面设置胶囊：左侧展示画面尺寸（比例缩略框、简称、导出档位与展开箭头）并触发设置浮层；
 * 右侧为参考线快捷开关（已开启任一参考线时一键全关，全关时开启九宫格与安全区）。无激活导出档位时在简称后补充 `宽×高`（简称本身已是 `宽×高` 时不重复）。
 * 常态仅露参考线开关，悬停、键盘聚焦或浮层展开时通过样式展开尺寸按钮（见 final-cut-stage.css 的 `.wf-stage-hud`）。
 */
export function CanvasSettings({ framing, onFraming, layer, ...settings }: CanvasSettingsProps) {
  const { canvas, tier } = settings
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const label = canvasLabel(canvas)
  const detail = tier !== undefined ? tierLabel(tier) : sizeText(canvas)
  const shown = detail === label ? label : `${label} · ${detail}`
  const output = tier === undefined ? undefined : exportOutput(canvas, tier)
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
                aria-label={`画面尺寸 ${shown}`}
                className="wf-stage-hud-size ui-state ui-focus"
                type="button"
              >
                <RatioGlyph canvas={canvas} />
                {label}
                {detail === label ? null : <span className="wf-stage-hud-tier">· {detail}</span>}
                <Icon decorative name="final-cut-expand" size="xs" />
              </button>
            </TooltipTrigger>
          </PopupTrigger>
          <TooltipContent className="wf-tip" container={layer} side="bottom">
            画面尺寸 {sizeText(canvas)}
            {output?.kind === 'preset' ? `，导出 ${sizeText(output.size)}` : null}
          </TooltipContent>
        </TooltipRoot>
        <PopupSurface
          align="end"
          aria-label="画面设置"
          className="wf-menu wf-canvas-settings"
          collisionPadding={8}
          container={layer}
          // 尺寸输入框内按 Esc 仅放弃当前输入，不关闭设置浮层
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
        tip={guided ? '关闭参考线' : '开启九宫格与安全区'}
        tipContainer={layer}
      />
    </div>
  )
}

/**
 * 画面设置浮层：包含六种预设比例、导出分辨率、宽高输入框与互换按钮、画布底色、构图网格及短视频安全区。
 * 宽高输入回车或失焦提交，奇数自动减 1，非法输入时在下方提示并恢复原值；修改尺寸与底色各记一步撤销。
 * 当前画幅不支持的导出档位置灰，悬停或点击展示原因说明。
 */
function SettingsPanel({
  canvas,
  onCanvas,
  tier,
  onTier,
  background,
  onBackground,
  framing,
  onFraming,
  layer,
}: CanvasSettingsProps) {
  // 记录最近一次校验失败的边，错误提示保持至下次修改成功
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
            <RatioGlyph canvas={each.canvas} />
            {each.label}
          </button>
        ))}
      </div>
      <hr className="wf-canvas-settings-sep" />
      <div className="wf-prop-field">
        <span className="wf-prop-label">导出分辨率</span>
        <div
          aria-label="导出分辨率"
          className="wf-seg wf-canvas-control wf-canvas-seg"
          role="group"
        >
          {EXPORT_TIERS.map((each) => {
            const blocked =
              exportOutput(canvas, each).kind === 'unsupported'
                ? tierUnsupportedText(each)
                : undefined
            return (
              <BlockedReason container={layer} key={each} reason={blocked}>
                <button
                  aria-disabled={blocked === undefined ? undefined : true}
                  aria-pressed={each === tier}
                  className="wf-seg-item ui-state ui-focus"
                  onClick={() => {
                    if (blocked === undefined) onTier(each)
                  }}
                  type="button"
                >
                  {tierLabel(each)}
                </button>
              </BlockedReason>
            )
          })}
        </div>
      </div>
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
              style={{ background: each.color }}
              type="button"
            />
          ))}
        </div>
      </div>
      <hr className="wf-canvas-settings-sep" />
      <div className="wf-prop-field">
        <span className="wf-prop-label">构图网格</span>
        <div aria-label="构图网格" className="wf-seg wf-canvas-control wf-canvas-seg" role="group">
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
 * 宽/高数值输入框：非编辑态展示 `value`；回车或失焦将草稿提交给 `onCommit`，按 Esc 放弃编辑并还原为 `value`。
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
  // 按 Esc 时先清空草稿再触发失焦，onBlur 直接读取该 ref，避免等待重新渲染
  const draftRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }
  return (
    <label className="wf-field is-outline wf-canvas-side">
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

// 宽高比不超过此阈值视为竖屏或方屏，按竖屏短视频布局绘制安全区
const UPRIGHT_MAX_RATIO = 1.05

/** 各构图网格模式在横纵方向上的参考线位置标识（样式定位见 final-cut-stage.css 的 `.wf-framing-line`）。 */
const GRID_LINES: Record<FramingGrid, readonly string[]> = {
  off: [],
  thirds: ['third', 'two-thirds'],
  cross: ['half'],
}

/**
 * 预览画面叠层参考线（尺寸与画面一致，见 `PreviewPlayer` 的 `overlay`）：绘制构图网格与短视频平台遮挡安全区。
 * 竖屏及方屏标注右侧互动区与底部信息遮挡区，横屏标注底部播控遮挡区；仅作编辑态视觉辅助，不拦截指针事件。
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
