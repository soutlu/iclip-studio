import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { mintUuid } from '@/shared/lib/uuid'
import { Button, IconButton } from '@/shared/ui/button'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { toast } from '@/shared/ui/toast'
import { MAX_ANNOTATIONS } from '../generation-limits'
import {
  annotationHandles,
  annotationVisual,
  imagePoint,
  isUsableAnnotation,
  moveAnnotation,
  placeAnnotationToolbar,
  resizeAnnotation,
} from './annotation-geometry'
import { TOO_MANY_ANNOTATIONS } from './image-edit-draft'
import type { AnnotationKind, AnnotationPoint, ImageAnnotation } from './image-edit-types'

type AnnotationCanvasProps = {
  url: string
  annotations: ImageAnnotation[]
  onChange: (annotations: ImageAnnotation[]) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  disabled?: boolean
  onInsertReference?: (id: string) => void
  /** 标注工具条渲染进的元素：由调用方摆位置（桌面叠在舞台左侧，窄屏在舞台下方一行）。
   * 还没挂上（null）时不渲染工具条。 */
  toolbarHost: HTMLElement | null
}

type Gesture = {
  pointerId: number
  kind: 'draw' | 'move' | 'resize'
  start: AnnotationPoint
  original: ImageAnnotation
  current: ImageAnnotation
  handle: number
}

const TOOLS = [
  { kind: 'point', label: '点标注' },
  { kind: 'rectangle', label: '矩形标注' },
  { kind: 'ellipse', label: '椭圆标注' },
  { kind: 'arrow', label: '箭头标注' },
  { kind: 'pen', label: '自由画笔' },
] as const

export function AnnotationCanvas({
  url,
  annotations,
  onChange,
  selectedId,
  onSelect,
  disabled = false,
  onInsertReference,
  toolbarHost,
}: AnnotationCanvasProps) {
  const [tool, setTool] = useState<AnnotationKind>('point')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [imageFailed, setImageFailed] = useState(false)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [nextNumber, setNextNumber] = useState(
    () => Math.max(0, ...annotations.map((annotation) => annotation.number)) + 1,
  )
  // 撤销栈只属于这次挂载：外部换掉整份标注（恢复输入、重新开始、换底图）时由父组件换 key 重挂。
  const [history, setHistory] = useState({
    past: [] as ImageAnnotation[][],
    future: [] as ImageAnnotation[][],
  })
  const blocked = disabled || !size.width || imageFailed
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const displayScale =
    size.width && viewport.width && viewport.height
      ? Math.min(viewport.width / size.width, viewport.height / size.height)
      : 1
  const unitsPerPixel = 1 / displayScale

  function commit(next: ImageAnnotation[]) {
    setHistory({ past: [...history.past, annotations].slice(-100), future: [] })
    onChange(next)
  }

  function undo() {
    const previous = history.past.at(-1)
    if (blocked || !previous || gesture) return
    setHistory({
      past: history.past.slice(0, -1),
      future: [annotations, ...history.future],
    })
    onChange(previous)
    if (!previous.some((annotation) => annotation.id === selectedId)) onSelect(null)
  }

  function redo() {
    const next = history.future[0]
    if (blocked || !next || gesture) return
    setHistory({
      past: [...history.past, annotations],
      future: history.future.slice(1),
    })
    onChange(next)
  }

  function removeSelected() {
    if (blocked || !selectedId || gesture) return
    commit(annotations.filter((annotation) => annotation.id !== selectedId))
    onSelect(null)
  }

  function clearAnnotations() {
    if (blocked || gesture || annotations.length === 0) return
    commit([])
    onSelect(null)
  }

  function pointerPoint(event: PointerEvent<SVGSVGElement>, constrain = false) {
    return imagePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      size,
      constrain,
    )
  }

  function startGesture(event: PointerEvent<SVGSVGElement>) {
    if (blocked || gesture || event.button !== 0) return
    const point = pointerPoint(event)
    if (!point) {
      onSelect(null)
      return
    }
    event.preventDefault()
    event.currentTarget.focus()
    const element = event.target instanceof Element ? event.target : null
    const shape = element?.closest('[data-annotation-id]')
    const selected = annotations.find(
      (annotation) => annotation.id === shape?.getAttribute('data-annotation-id'),
    )
    const handleValue = element?.closest('[data-handle]')?.getAttribute('data-handle')
    const handle = handleValue == null ? -1 : Number(handleValue)
    let original: ImageAnnotation
    let kind: Gesture['kind']
    if (selected) {
      original = selected
      kind = handle >= 0 ? 'resize' : 'move'
    } else {
      // 第一次空白点击仅取消当前选择，不能意外新增点或笔迹。
      if (selectedId !== null) {
        onSelect(null)
        return
      }
      if (annotations.length >= MAX_ANNOTATIONS) {
        toast.error(TOO_MANY_ANNOTATIONS)
        return
      }
      original = {
        id: mintUuid(),
        number: nextNumber,
        kind: tool,
        points: tool === 'point' ? [point] : [point, point],
      }
      kind = 'draw'
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (kind !== 'draw') onSelect(original.id)
    setGesture({
      pointerId: event.pointerId,
      kind,
      start: point,
      original,
      current: original,
      handle,
    })
  }

  function updateGesture(event: PointerEvent<SVGSVGElement>) {
    if (blocked || !gesture || gesture.pointerId !== event.pointerId) return
    const point = pointerPoint(event, true)
    if (!point) return
    setGesture((previous) => {
      if (!previous) return null
      let current: ImageAnnotation
      if (previous.kind === 'move') {
        current = moveAnnotation(previous.original, {
          x: point.x - previous.start.x,
          y: point.y - previous.start.y,
        })
      } else if (previous.kind === 'resize') {
        current = resizeAnnotation(previous.original, previous.handle, point)
      } else if (previous.original.kind === 'point') {
        current = { ...previous.original, points: [point] }
      } else if (previous.original.kind === 'pen') {
        const last = previous.current.points.at(-1)
        if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.001) return previous
        // 长笔迹均匀降采样，保留整段轨迹，不能截断后把终点直接连回第 499 个点。
        const points =
          previous.current.points.length >= 500
            ? previous.current.points.filter((_, index) => index % 2 === 0)
            : previous.current.points
        current = { ...previous.current, points: [...points, point] }
      } else {
        current = { ...previous.original, points: [previous.start, point] }
      }
      return { ...previous, current }
    })
  }

  function finishGesture(event: PointerEvent<SVGSVGElement>) {
    if (!gesture || gesture.pointerId !== event.pointerId) return
    setGesture(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (blocked) return
    if (!isUsableAnnotation(gesture.current)) {
      if (gesture.kind === 'draw') onSelect(null)
      return
    }
    if (gesture.kind === 'draw') {
      commit([...annotations, gesture.current])
      setNextNumber(nextNumber + 1)
      onSelect(null)
    } else if (gesture.current !== gesture.original) {
      commit(
        annotations.map((annotation) =>
          annotation.id === gesture.current.id ? gesture.current : annotation,
        ),
      )
    }
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (blocked) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) redo()
      else undo()
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      event.stopPropagation()
      redo()
    } else if (event.key === 'Escape' && (gesture || selectedId)) {
      event.preventDefault()
      event.stopPropagation()
      setGesture(null)
      onSelect(null)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      removeSelected()
    } else if (
      event.target instanceof SVGElement &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      const selected = annotations.find((annotation) => annotation.id === selectedId)
      if (!selected) return
      event.preventDefault()
      event.stopPropagation()
      const distance = event.shiftKey ? 0.05 : 0.01
      const next = moveAnnotation(selected, {
        x: event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0,
        y: event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0,
      })
      commit(annotations.map((annotation) => (annotation.id === next.id ? next : annotation)))
    }
  }

  const visible =
    gesture?.kind === 'draw'
      ? [...annotations, gesture.current]
      : annotations.map((annotation) =>
          annotation.id === gesture?.current.id ? gesture.current : annotation,
        )

  const selectedAnnotation = visible.find((annotation) => annotation.id === selectedId)
  const toolbar = selectedAnnotation
    ? placeAnnotationToolbar({
        viewport,
        image: { ...size, scale: displayScale },
        selected: annotationVisual(selectedAnnotation, size, unitsPerPixel),
        labels: visible.map(
          (annotation) => annotationVisual(annotation, size, unitsPerPixel).label,
        ),
      })
    : null

  // 工具与撤销、重做、清空分两组：窄屏排成一行时两组各靠一端。
  const tools = (
    <div className="image-edit-tools" role="toolbar" aria-label="标注工具">
      <div className="image-edit-tools-group">
        {TOOLS.map(({ kind, label }) => (
          <IconButton
            key={kind}
            label={label}
            name={kind}
            size="sm"
            aria-pressed={tool === kind}
            disabled={Boolean(blocked)}
            onClick={() => {
              setTool(kind)
              onSelect(null)
            }}
          />
        ))}
      </div>
      <span className="image-edit-tools-divider" aria-hidden="true" />
      <div className="image-edit-tools-group">
        <IconButton
          label="撤销标注"
          name="undo"
          size="sm"
          disabled={Boolean(blocked) || history.past.length === 0}
          onClick={undo}
        />
        <IconButton
          label="重做标注"
          name="redo"
          size="sm"
          disabled={Boolean(blocked) || history.future.length === 0}
          onClick={redo}
        />
        <IconButton
          label="清空标注"
          name="delete"
          size="sm"
          tooltip="清空全部标注，可撤销"
          disabled={Boolean(blocked) || annotations.length === 0 || gesture !== null}
          onClick={clearAnnotations}
        />
      </div>
    </div>
  )
  const ready = size.width > 0 && !imageFailed

  return (
    <div className="image-edit-canvas" role="group" aria-label="图片标注编辑器">
      {toolbarHost === null ? null : createPortal(tools, toolbarHost)}
      <div
        ref={viewportRef}
        className="image-edit-canvas-viewport"
        onPointerDown={(event) => {
          // 图框只有图那么大，点在图外的舞台上落在这里：与点在图上的空白一样，只取消选择。
          if (event.target === event.currentTarget && !blocked && !gesture) onSelect(null)
        }}
      >
        {/* 图框按图片本身的宽高比 contain 在可用区域里，圆角投影画在它上面；读到尺寸前铺满、不画投影。 */}
        <div
          className={ready ? 'image-edit-canvas-frame stage-picture' : 'image-edit-canvas-frame'}
          data-ready={ready ? '' : undefined}
          style={
            ready
              ? ({ '--image-edit-canvas-ratio': size.width / size.height } as CSSProperties)
              : undefined
          }
        >
          <img
            src={url}
            alt="当前编辑帧"
            className="image-edit-canvas-source"
            draggable={false}
            onLoad={(event) => {
              setImageFailed(false)
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }}
            onError={() => setImageFailed(true)}
          />
          {ready && (
            <svg
              onKeyDown={handleKeyDown}
              data-annotation-canvas=""
              className="image-edit-canvas-surface ui-focus ui-focus-inline"
              viewBox={`0 0 ${size.width} ${size.height}`}
              preserveAspectRatio="xMidYMid meet"
              role="group"
              aria-label="图片标注画布"
              tabIndex={0}
              style={{
                touchAction: 'none',
                cursor: blocked ? 'default' : 'crosshair',
              }}
              onPointerDown={startGesture}
              onPointerMove={updateGesture}
              onPointerUp={finishGesture}
              onPointerCancel={() => {
                setGesture(null)
                if (gesture?.kind === 'draw') onSelect(null)
              }}
              onLostPointerCapture={() => {
                setGesture(null)
              }}
            >
              {visible.map((annotation) => (
                <AnnotationMark
                  key={annotation.id}
                  annotation={annotation}
                  size={size}
                  unitsPerPixel={unitsPerPixel}
                  draft={gesture?.kind === 'draw' && gesture.current.id === annotation.id}
                  selected={annotation.id === selectedId}
                  disabled={Boolean(blocked)}
                  onSelect={() => onSelect(annotation.id)}
                />
              ))}
            </svg>
          )}
        </div>
        {imageFailed && (
          <div role="alert">
            <MediaFallback hint="请关闭后重试" kind="image" />
          </div>
        )}
        {selectedAnnotation && toolbar && !blocked && !gesture && (
          <div
            className="image-edit-annotation-actions"
            role="toolbar"
            aria-label={`标注 ${selectedAnnotation.number} 操作`}
            style={{ left: toolbar.left, top: toolbar.top, width: toolbar.width }}
          >
            <span className="min-w-0 flex-1 truncate text-body text-on-surface">
              标注 {selectedAnnotation.number} · {TOOL_NAMES[selectedAnnotation.kind]}
            </span>
            {onInsertReference && (
              <Button
                variant="ghost"
                size="md"
                aria-label="引用选中标注"
                onClick={() => onInsertReference(selectedAnnotation.id)}
              >
                引用
              </Button>
            )}
            <IconButton label="删除此标注" name="delete" onClick={removeSelected} />
          </div>
        )}
      </div>
    </div>
  )
}

const TOOL_NAMES: Record<AnnotationKind, string> = {
  point: '点',
  rectangle: '矩形',
  ellipse: '椭圆',
  arrow: '箭头',
  pen: '画笔',
}

function AnnotationMark({
  annotation,
  size,
  unitsPerPixel,
  draft,
  selected,
  disabled,
  onSelect,
}: {
  annotation: ImageAnnotation
  size: { width: number; height: number }
  unitsPerPixel: number
  draft: boolean
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const geometry = annotationVisual(annotation, size, unitsPerPixel)
  const points = geometry.points.map((p) => `${p.x},${p.y}`).join(' ')
  const shape =
    annotation.kind === 'rectangle' ? (
      <rect x={geometry.left} y={geometry.top} width={geometry.width} height={geometry.height} />
    ) : annotation.kind === 'ellipse' ? (
      <ellipse
        cx={geometry.left + geometry.width / 2}
        cy={geometry.top + geometry.height / 2}
        rx={geometry.width / 2}
        ry={geometry.height / 2}
      />
    ) : annotation.kind === 'pen' ? (
      <path d={geometry.penPath} />
    ) : annotation.kind === 'arrow' ? (
      <>
        <polyline points={points} />
        <polyline points={geometry.arrow.map((p) => `${p.x},${p.y}`).join(' ')} />
      </>
    ) : (
      <circle cx={geometry.anchor.x} cy={geometry.anchor.y} r={geometry.targetRadius} />
    )
  const connector = `${geometry.connector.start.x},${geometry.connector.start.y} ${geometry.connector.end.x},${geometry.connector.end.y}`
  const unit = unitsPerPixel
  return (
    <g
      data-annotation-id={draft ? undefined : annotation.id}
      data-annotation-kind={annotation.kind}
      role={draft ? undefined : 'button'}
      tabIndex={disabled || draft ? -1 : 0}
      aria-label={draft ? undefined : `标注 ${annotation.number}`}
      aria-pressed={draft ? undefined : selected}
      aria-disabled={disabled}
      onKeyDown={(event) => {
        if (!disabled && !draft && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      className="image-edit-annotation"
      style={{
        color: 'var(--color-error)',
        cursor: draft ? 'crosshair' : selected ? 'move' : 'pointer',
      }}
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {selected && (
          <g
            stroke="currentColor"
            strokeWidth={geometry.strokeWidth + 6 * unit}
            opacity={0.2}
            pointerEvents="none"
          >
            {shape}
          </g>
        )}
        <g
          stroke="var(--color-on-scrim)"
          strokeWidth={geometry.strokeWidth + geometry.haloWidth}
          pointerEvents="none"
        >
          {shape}
        </g>
        <g stroke="currentColor" strokeWidth={geometry.strokeWidth} data-annotation-outline="">
          {shape}
        </g>
        <g
          stroke="transparent"
          strokeWidth={Math.max(12 * unit, geometry.strokeWidth)}
          fill={annotation.kind === 'point' ? 'transparent' : 'none'}
          pointerEvents={annotation.kind === 'point' ? 'all' : 'stroke'}
          aria-hidden="true"
        >
          {shape}
        </g>
      </g>
      {annotation.kind === 'point' && (
        <circle
          cx={geometry.anchor.x}
          cy={geometry.anchor.y}
          r={geometry.targetDotRadius}
          paintOrder="stroke fill"
          fill="currentColor"
          stroke="var(--color-on-scrim)"
          strokeWidth={2 * unit}
          pointerEvents="none"
        />
      )}
      {!draft && (
        <g data-annotation-label="">
          <polyline
            points={connector}
            fill="none"
            stroke="var(--color-on-scrim)"
            strokeWidth={5 * unit}
            pointerEvents="none"
          />
          <polyline
            points={connector}
            fill="none"
            stroke="var(--color-scrim)"
            strokeWidth={2 * unit}
            pointerEvents="none"
          />
          {/* 序号与标注线同色的红色实心，细白圈；导出给模型的标注图同样画法（annotation-export）。 */}
          <rect
            x={geometry.label.x - geometry.label.width / 2}
            y={geometry.label.y - geometry.label.height / 2}
            width={geometry.label.width}
            height={geometry.label.height}
            rx={geometry.label.radius}
            fill="currentColor"
            stroke="var(--color-on-scrim)"
            strokeWidth={1.5 * unit}
          />
          <text
            x={geometry.label.x}
            y={geometry.label.y}
            fill="var(--color-on-scrim)"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={geometry.label.fontSize}
            fontWeight={600}
            pointerEvents="none"
          >
            {annotation.number}
          </text>
        </g>
      )}
      {selected &&
        !disabled &&
        annotationHandles(annotation).map((point, index) => {
          const x = point.x * size.width
          const y = point.y * size.height
          const handleSize = 8 * unit
          const cursor =
            annotation.kind === 'arrow'
              ? 'move'
              : annotation.kind === 'ellipse'
                ? index % 2 === 0
                  ? 'ns-resize'
                  : 'ew-resize'
                : index % 2 === 0
                  ? 'nwse-resize'
                  : 'nesw-resize'
          return (
            <g
              key={['top', 'right', 'bottom', 'left'][index]}
              data-handle={index}
              style={{ cursor }}
            >
              <rect
                x={x - 10 * unit}
                y={y - 10 * unit}
                width={20 * unit}
                height={20 * unit}
                fill="transparent"
              />
              {annotation.kind === 'rectangle' ? (
                <rect
                  x={x - handleSize / 2}
                  y={y - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  rx={unit}
                  fill="var(--color-on-scrim)"
                  stroke="currentColor"
                  strokeWidth={1.5 * unit}
                />
              ) : (
                <circle
                  cx={x}
                  cy={y}
                  r={handleSize / 2}
                  fill="var(--color-on-scrim)"
                  stroke="currentColor"
                  strokeWidth={1.5 * unit}
                />
              )}
            </g>
          )
        })}
    </g>
  )
}
