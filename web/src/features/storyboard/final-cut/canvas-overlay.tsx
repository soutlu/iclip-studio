import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { CanvasGuides } from './canvas-guides'
import type { Shown } from './canvas-gesture'
import { hoverOf, hoverProbe, type HoverProbe } from './canvas-hover'
import type { CanvasLayer } from './canvas-layers'
import type { Frame, Point } from './canvas-geometry'
import { CanvasText } from './canvas-text'
import { textEditOf } from './canvas-text-edit'
import { drawnFrame, followFrame } from './canvas-visible'
import type { CaptionTextChange } from './captions-tab'
import type { ComponentCatalog } from './composition/catalog'
import { itemNamed, type Canvas, type FilmClip } from './composition/film'
import { textFields, type LocaleBindings } from './composition/locale-text'
import type { ItemTextChange } from './component-texts'
import type { ShownLocale } from './locales'
import type { PickedLayer, PreviewControl, TextTarget } from './preview-player'
import type { LayerMeasure } from './preview-protocol'
import { useCanvasGesture, type CanvasNudge } from './use-canvas-gesture'
import type { LayerEdit } from './use-film-session'

export type { CanvasNudge } from './use-canvas-gesture'

/** 指针移动时向预览页查询悬停命中图层的最小间隔（毫秒）。 */
const HOVER_INTERVAL = 80

type CanvasOverlayProps = {
  canvas: Canvas
  /** 当前工程时间线片段列表（按源码顺序）。 */
  clips: readonly FilmClip[]
  /** 画布可编辑图层与宿主表（见 canvas-layers.ts），与同步给预览页的表一致。 */
  layers: readonly CanvasLayer[]
  /** 预览页回传的已订阅图层测量表（表下标 → 测量结果）。 */
  measures: ReadonlyMap<number, LayerMeasure>
  /** 更新需要预览页测量的图层下标列表。 */
  onWatch: (layers: readonly number[]) => void
  /** 读取已打开工程文件的当前内容（相对工程根路径；未打开时返回 `undefined`）。 */
  contentOf: (file: string) => string | undefined
  /** 当前画面停留毫秒数（据此判断片段是否在场）。 */
  frameMs: number
  /** 是否正在播放（播放期间暂停悬停预选框探测）。 */
  playing: boolean
  /** 工程修订号；外部变更导致修订号推进时自动中止在途拖拽。 */
  revision: number
  selected: ReadonlySet<string>
  controlRef: RefObject<PreviewControl | null>
  onSelect: (ids: ReadonlySet<string>) => void
  /** 松手或按方向键微调时将图层变更写入所属文件（合并为单步撤销）。 */
  onEdit: (edits: readonly LayerEdit[]) => void
  /** 通知外层编辑器画布拖拽或原地改字是否进行中，以便临时让出全局快捷键与 Esc。 */
  onGesture: (active: boolean) => void
  /** 预览页定位到的原地改字目标；未处于改字状态时为 `null`。 */
  textTarget: TextTarget | null
  onTextClose: () => void
  catalog: ComponentCatalog
  locale: ShownLocale
  bindings: ReadonlyMap<string, LocaleBindings>
  onText: ItemTextChange
  /** 提交单句字幕文本修改（作用于当前展示语言）。 */
  onCaptionText: CaptionTextChange
  onNotice: (message: string) => void
  /** 注册画布方向键微调处理器（已消费按键时返回 `true`）。 */
  nudgeRef: RefObject<CanvasNudge | null>
}

/**
 * 覆盖在预览画面上方的交互编辑叠层：
 * - 点选与循环换层：视频片段、单句字幕各自为一层，元素与模板片段整体映射为其主文件宿主（仅命中内部可视内容时触发，透明空白区透传至下方）；
 *   点击即与时间线同步选中状态，同位置快速连点切换下层，Shift 点击加选。
 * - 拖拽、缩放、旋转与微调：支持拖拽移动（带对齐吸附与参考线）、四角中心等比缩放、旋转（Shift 按 15° 吸附）及画布焦点下方向键 1px / 10px 微调；
 *   拖拽期间实时驱动预览草稿，松手按 layer-edits.ts 规则一次提交并记为单步撤销；锁定或动画脚本驱动的属性在操作时给出提示。
 * - 悬停与原地改字：静止时悬停绘制可见裁剪预选框，落在字幕或绑定文字可填项的元素上时切换输入光标，双击原位编辑当前语言文本。
 */
export function CanvasOverlay({
  canvas,
  clips,
  layers,
  measures,
  onWatch,
  contentOf,
  frameMs,
  playing,
  revision,
  selected,
  controlRef,
  onSelect,
  onEdit,
  onGesture,
  textTarget,
  onTextClose,
  catalog,
  locale,
  bindings,
  onText,
  onCaptionText,
  onNotice,
  nudgeRef,
}: CanvasOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    // 开始观察时就报一次现在的大小
    const observer = new ResizeObserver(() => setWidth(layer.clientWidth))
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])
  // 画布一像素在屏幕上多宽
  const zoom = width > 0 && canvas.width > 0 ? width / canvas.width : 0

  const select = (next: ReadonlySet<string>) => {
    if (next !== selected) onSelect(next)
  }

  const clipOf = new Map(clips.map((clip) => [clip.id, clip]))
  const shownAt = (clipId: string) => {
    const clip = clipOf.get(clipId)
    return (
      clip !== undefined &&
      !clip.hidden &&
      clip.start <= frameMs &&
      frameMs < clip.start + clip.duration
    )
  }

  /** 查找选中片段在图层表中的下标：视频/单句字幕取自身元素，元素/模板取其宿主。 */
  const watchedOf = (clipId: string): number | undefined => {
    const own = layers.findIndex(
      (layer) => layer.clip === clipId && (layer.host || layer.element.hfId === clipId),
    )
    return own < 0 ? undefined : own
  }
  const watching = [...selected].flatMap((clipId) => {
    const at = watchedOf(clipId)
    return at === undefined ? [] : [at]
  })
  const watchKey = watching.join(',')
  const watch = useEffectEvent((next: readonly number[]) => onWatch(next))
  useEffect(() => {
    watch(watchKey === '' ? [] : watchKey.split(',').map(Number))
  }, [watchKey])

  const shown: Shown[] = watching.flatMap((at) => {
    const layer = layers[at]
    const measure = measures.get(at)
    return layer === undefined || measure === undefined || !shownAt(layer.clip)
      ? []
      : [{ at, layer, measure }]
  })

  const toCanvas = (event: { clientX: number; clientY: number }): Point => {
    const rect = layerRef.current?.getBoundingClientRect()
    const scale = rect === undefined || rect.width === 0 ? 1 : rect.width / canvas.width
    return {
      x: (event.clientX - (rect?.left ?? 0)) / scale,
      y: (event.clientY - (rect?.top ?? 0)) / scale,
    }
  }

  // 悬停状态绑定请求发起时的帧时刻与工程修订号，发生跳帧或工程变更后旧结果自动失效
  const stamp = `${frameMs}/${revision}`
  const stampRef = useRef(stamp)
  useLayoutEffect(() => {
    stampRef.current = stamp
  }, [stamp])
  const [hovering, setHovering] = useState<{
    stack: readonly PickedLayer[]
    stamp: string
  } | null>(null)
  const probeRef = useRef<HoverProbe | null>(null)
  useEffect(() => {
    const probe = hoverProbe(
      (point: Point) => {
        const asked = stampRef.current
        const pick = controlRef.current?.pick(point) ?? Promise.resolve([])
        return pick.then((stack) => ({ stack, stamp: asked }))
      },
      setHovering,
      HOVER_INTERVAL,
    )
    probeRef.current = probe
    return () => {
      probe.stop()
      probeRef.current = null
    }
  }, [controlRef])
  const unhover = () => {
    probeRef.current?.stop()
    setHovering(null)
  }
  /** 判断是否为单句字幕自身图层（位于最上层时单击直接优先选中，见 use-canvas-gesture.ts 的 `clicked`）。 */
  const isCaption = (layer: CanvasLayer) =>
    clipOf.get(layer.clip)?.kind === 'caption' && layer.element.hfId === layer.clip
  /** 判断当前位置是否支持原地改字：单句字幕，或元素/模板内绑定了文字可填项（`field`）的元素。 */
  const isText = (layer: CanvasLayer, field: string | null) => {
    if (isCaption(layer)) return true
    const clip = clipOf.get(layer.clip)
    if (clip?.kind !== 'host' || !layer.host || field === null) return false
    const item = itemNamed(catalog, clip.item)
    return item !== undefined && textFields(item).some((each) => each.id === field)
  }

  // 只选中一层时才有把手；不能缩放、不能转的不出那个把手
  const single = shown.length === 1 ? shown[0] : undefined
  const { draft, cancel, onPointerDown, onPointerMove, onPointerUp } = useCanvasGesture({
    canvas,
    layers,
    shown,
    single,
    selected,
    select,
    zoom,
    layerRef,
    toCanvas,
    isCaption,
    controlRef,
    contentOf,
    revision,
    playing,
    unhover,
    probeRef,
    onEdit,
    onGesture,
    onNotice,
    nudgeRef,
  })

  const hover =
    hovering === null ||
    hovering.stamp !== stamp ||
    playing ||
    draft !== null ||
    textTarget !== null
      ? null
      : hoverOf(hovering.stack, layers, new Set(shown.map((each) => each.layer.key)), {
          isText,
          winsOnTop: isCaption,
        })

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const point = toCanvas(event)
    void controlRef.current?.pick(point).then(([top]) => {
      const layer = top === undefined ? undefined : layers[top.layer]
      if (layer === undefined) return
      const clip = clipOf.get(layer.clip)
      if (clip?.kind === 'caption' && clip.id === layer.element.hfId) {
        select(new Set([clip.id]))
        controlRef.current?.editText(clip.id, point, [clip.variable])
        return
      }
      // 元素、模板片段：在宿主里找指针下的文字字段
      if (clip?.kind !== 'host' || !layer.host) return
      const item = itemNamed(catalog, clip.item)
      const fields = item === undefined ? [] : textFields(item)
      if (fields.length === 0) return
      select(new Set([clip.id]))
      controlRef.current?.editText(
        clip.id,
        point,
        fields.map((field) => field.id),
      )
    })
  }

  const closeText = (refocus: boolean) => {
    if (refocus) layerRef.current?.focus({ preventScroll: true })
    onTextClose()
  }

  const textEdit =
    textTarget === null
      ? undefined
      : textEditOf(textTarget, clips, { catalog, locale, bindings, onText, onCaptionText })
  // 改着字的片段没了（别处改了 final-cut）：不改了，藏起来的字显示回来
  const orphanText = textTarget !== null && textEdit === undefined
  const dropText = useEffectEvent(() => {
    controlRef.current?.endText(null)
    onGesture(false)
    onTextClose()
  })
  useEffect(() => {
    if (orphanText) dropText()
  }, [orphanText])

  const frameStyle = (frame: Frame) => ({
    left: (frame.cx - frame.width / 2) * zoom,
    top: (frame.cy - frame.height / 2) * zoom,
    width: frame.width * zoom,
    height: frame.height * zoom,
    rotate: `${frame.angle}deg`,
  })
  return (
    <div
      aria-label="预览画面"
      className="wf-canvas-layer"
      data-canvas-layer=""
      data-hover-text={hover?.text === true ? '' : undefined}
      onDoubleClick={onDoubleClick}
      onLostPointerCapture={onPointerUp}
      onPointerCancel={cancel}
      onPointerDown={onPointerDown}
      onPointerLeave={unhover}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={layerRef}
      role="group"
      tabIndex={-1}
    >
      {hover === null ? null : (
        <div
          aria-hidden="true"
          className="wf-canvas-hover"
          data-testid="canvas-hover"
          style={frameStyle(hover.frame)}
        />
      )}
      {shown.map((each) => {
        const { at, layer, measure } = each
        // 原地改着的字幕：框和输入框叠在一起，不画
        if (textTarget?.id === layer.element.hfId) return null
        // 画在看得见的那一块上；拖动中跟着这一层的草稿走
        const drafted = draft?.frames.get(at)
        const frame =
          drafted === undefined
            ? drawnFrame(measure)
            : followFrame(drawnFrame(measure), measure.frame, drafted)
        return (
          <div
            aria-label={`选中：${clipOf.get(layer.clip)?.label ?? layer.clip}`}
            className="wf-canvas-frame"
            key={layer.key}
            role="img"
            style={frameStyle(frame)}
          >
            {single === each ? (
              <>
                {measure.resize
                  ? (['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                      <span
                        aria-hidden="true"
                        className="wf-canvas-handle"
                        data-corner={corner}
                        data-handle="resize"
                        key={corner}
                      />
                    ))
                  : null}
                {measure.turn ? (
                  <button
                    aria-label="旋转"
                    className="wf-canvas-rotate"
                    data-handle="rotate"
                    tabIndex={-1}
                    type="button"
                  >
                    <Icon decorative name="rotate" size="xs" />
                  </button>
                ) : null}
                {draft?.kind === 'rotate' ? (
                  <span className="wf-canvas-angle">{`${Math.round(frame.angle)}°`}</span>
                ) : null}
              </>
            ) : null}
          </div>
        )
      })}
      {draft === null || draft.guides === null ? null : <CanvasGuides guides={draft.guides} />}
      {textTarget !== null && textEdit !== undefined ? (
        <CanvasText
          controlRef={controlRef}
          edit={textEdit}
          key={`${textTarget.id}/${textTarget.field}`}
          onClose={closeText}
          onGesture={onGesture}
          onNotice={onNotice}
          target={textTarget}
          zoom={zoom}
        />
      ) : null}
    </div>
  )
}
