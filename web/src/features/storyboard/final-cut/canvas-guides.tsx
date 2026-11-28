import type { SnapGuides } from './canvas-snap'

/** 渲染拖拽对齐参考线与等距间距标记（见 canvas-snap.ts，纯视觉层不拦截指针）。 */
export function CanvasGuides({ guides }: { guides: SnapGuides }) {
  return (
    <div aria-hidden="true" className="wf-canvas-guides">
      {guides.lines.map((line) => (
        <div
          className="wf-canvas-guide"
          data-testid="canvas-guide"
          key={line.key}
          style={{ left: line.left, top: line.top, width: line.width, height: line.height }}
        />
      ))}
      {guides.spacings.map((spacing) => (
        <div
          className="wf-canvas-spacing"
          data-axis={spacing.axis}
          data-testid="canvas-spacing"
          key={spacing.key}
          style={{
            left: spacing.left,
            top: spacing.top,
            width: spacing.width,
            height: spacing.height,
          }}
        >
          <span>{spacing.gap}</span>
        </div>
      ))}
    </div>
  )
}
