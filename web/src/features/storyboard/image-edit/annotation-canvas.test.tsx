import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { renderWithProviders } from '@/testing/render'
import { MAX_ANNOTATIONS } from '../generation-limits'
import { AnnotationCanvas } from './annotation-canvas'
import { TOO_MANY_ANNOTATIONS } from './image-edit-draft'
import type { ImageAnnotation } from './image-edit-types'

const original: ImageAnnotation = {
  id: 'jacket',
  number: 1,
  kind: 'rectangle',
  points: [
    { x: 0.2, y: 0.3 },
    { x: 0.6, y: 0.8 },
  ],
}

function Editor({
  initial = [],
  disabled = false,
  onInsertReference,
  onChange,
}: {
  initial?: ImageAnnotation[]
  disabled?: boolean
  onInsertReference?: (id: string) => void
  onChange?: (annotations: ImageAnnotation[]) => void
}) {
  const [annotations, setAnnotations] = useState(initial)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 编辑器把工具条摆在舞台旁的宿主里，这里同样给一个。
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <AnnotationCanvas
        url="/frame.png"
        annotations={annotations}
        onChange={(next) => {
          setAnnotations(next)
          onChange?.(next)
        }}
        selectedId={selectedId}
        onSelect={setSelectedId}
        disabled={disabled}
        toolbarHost={toolbarHost}
        {...(onInsertReference ? { onInsertReference } : {})}
      />
      <div ref={setToolbarHost} />
    </>
  )
}

function loadImage() {
  const image = screen.getByRole('img', { name: '当前编辑帧' })
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 800 } })
  fireEvent.load(image)
  const canvas = screen.getByRole('group', { name: '图片标注画布' })
  Object.assign(canvas, {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  return canvas
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly callback: (entries: { contentRect: { width: number; height: number } }[]) => void
      constructor(
        callback: (entries: { contentRect: { width: number; height: number } }[]) => void,
      ) {
        this.callback = callback
      }
      observe() {
        this.callback([{ contentRect: { width: 800, height: 800 } }])
      }
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      readonly pointerId = 1
    },
  )
})
afterEach(() => {
  // Toaster 是模块级单例，提示不清掉会串进下一条用例。
  toast.dismiss()
  vi.unstubAllGlobals()
})

describe('annotation canvas', () => {
  it('draws one gesture, ignores letterboxing, and supports delete with undo/redo', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Editor />)
    const canvas = loadImage()
    await user.click(screen.getByRole('button', { name: '椭圆标注' }))
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100, button: 0 })
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    fireEvent.pointerDown(canvas, { clientX: 280, clientY: 240, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 440, clientY: 640 })
    fireEvent.pointerUp(canvas, { clientX: 440, clientY: 640 })
    expect(screen.getByRole('button', { name: '标注 1' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '椭圆标注' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '撤销标注' }))
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重做标注' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '标注 1' }), { key: 'Enter' })
    fireEvent.keyDown(canvas, { key: 'Delete' })
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true })
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
  })

  it('moves and resizes the selected mark while preserving its reference identity', async () => {
    const changed = vi.fn()
    await renderWithProviders(<Editor initial={[original]} onChange={changed} />)
    const canvas = loadImage()
    const mark = screen.getByRole('button', { name: '标注 1' })
    fireEvent.pointerDown(mark, { clientX: 300, clientY: 300, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 340, clientY: 380 })
    fireEvent.pointerUp(canvas, { clientX: 340, clientY: 380 })
    const moved = {
      ...original,
      points: [
        { x: expect.closeTo(0.3), y: expect.closeTo(0.4) },
        { x: expect.closeTo(0.7), y: expect.closeTo(0.9) },
      ],
    }
    expect(changed).toHaveBeenLastCalledWith([moved])
    const handle = mark.querySelector('[data-handle="2"]')
    if (!handle) throw new Error('Missing resize handle')
    fireEvent.pointerDown(handle, { clientX: 480, clientY: 720, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 560, clientY: 760 })
    fireEvent.pointerUp(canvas, { clientX: 560, clientY: 760 })
    expect(changed).toHaveBeenLastCalledWith([
      {
        ...original,
        points: [
          { x: expect.closeTo(0.3), y: expect.closeTo(0.4) },
          { x: expect.closeTo(0.9), y: expect.closeTo(0.95) },
        ],
      },
    ])
    fireEvent.keyDown(canvas, { key: 'z', metaKey: true })
    expect(changed).toHaveBeenLastCalledWith([moved])
  })

  it('discards a cancelled stroke without changing the committed annotation', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Editor initial={[original]} />)
    const canvas = loadImage()
    await user.click(screen.getByRole('button', { name: '自由画笔' }))
    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 340, clientY: 380 })
    fireEvent.pointerCancel(canvas)
    expect(screen.queryByRole('button', { name: '标注 2' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销标注' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('shows image failures and disallows drawing while the editor is busy', async () => {
    await renderWithProviders(<Editor initial={[original]} disabled />)
    const canvas = loadImage()
    expect(screen.getByRole('button', { name: '矩形标注' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    fireEvent.keyDown(screen.getByRole('button', { name: '标注 1' }), { key: 'Enter' })
    fireEvent.keyDown(canvas, { key: 'Delete' })
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
    fireEvent.error(screen.getByRole('img', { name: '当前编辑帧' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '图片标注画布' })).not.toBeInTheDocument()
  })

  it('places continuous single points and separates selection dismissal from drawing', async () => {
    const changed = vi.fn()
    await renderWithProviders(<Editor onChange={changed} />)
    const canvas = loadImage()
    expect(screen.queryByRole('button', { name: '选择标注' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '点标注' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, button: 0 })
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 400, button: 0 })
    const first = screen.getByRole('button', { name: '标注 1' })
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ number: 1, kind: 'point', points: [{ x: 0.5, y: 0.5 }] }),
    ])
    fireEvent.pointerDown(canvas, { clientX: 440, clientY: 480, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 440, clientY: 480, button: 0 })
    expect(screen.getByRole('button', { name: '标注 2' })).toBeInTheDocument()
    fireEvent.pointerDown(first, { clientX: 400, clientY: 400, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 400, button: 0 })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    fireEvent.pointerDown(canvas, { clientX: 560, clientY: 600, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 560, clientY: 600, button: 0 })
    expect(first).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: '标注 3' })).not.toBeInTheDocument()
    fireEvent.pointerDown(canvas, { clientX: 560, clientY: 600, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 560, clientY: 600, button: 0 })
    expect(screen.getByRole('button', { name: '标注 3' })).toBeInTheDocument()
  })

  it('selects a pen stroke and references it from the contextual bar', async () => {
    const user = userEvent.setup()
    const insert = vi.fn()
    const changed = vi.fn()
    await renderWithProviders(<Editor onInsertReference={insert} onChange={changed} />)
    const canvas = loadImage()
    expect(screen.queryByRole('button', { name: '引用选中标注' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '自由画笔' }))
    fireEvent.pointerDown(canvas, { clientX: 280, clientY: 400, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 320, clientY: 320 })
    fireEvent.pointerMove(canvas, { clientX: 360, clientY: 300 })
    fireEvent.pointerUp(canvas, { clientX: 360, clientY: 300, button: 0 })
    const mark = screen.getByRole('button', { name: '标注 1' })
    fireEvent.keyDown(mark, { key: 'Enter' })
    expect(mark).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('toolbar', { name: '标注 1 操作' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '引用选中标注' }))
    const committed = changed.mock.lastCall?.[0] as ImageAnnotation[]
    expect(committed).toEqual([expect.objectContaining({ kind: 'pen', number: 1 })])
    expect(insert).toHaveBeenCalledWith(committed[0]?.id)
    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(mark).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('toolbar', { name: '标注 1 操作' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '自由画笔' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clears all annotations without a selection and restores them together with undo', async () => {
    const user = userEvent.setup()
    const point: ImageAnnotation = {
      id: 'boot',
      number: 2,
      kind: 'point',
      points: [{ x: 0.8, y: 0.2 }],
    }
    const changed = vi.fn()
    await renderWithProviders(<Editor initial={[original, point]} onChange={changed} />)
    const canvas = loadImage()
    const clear = screen.getByRole('button', { name: '清空标注' })
    expect(clear).not.toHaveAttribute('aria-disabled')
    await user.click(clear)
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '标注 2' })).not.toBeInTheDocument()
    expect(clear).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: '撤销标注' }))
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标注 2' })).toBeInTheDocument()
    expect(changed).toHaveBeenLastCalledWith([original, point])
    await user.click(screen.getByRole('button', { name: '重做标注' }))
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '标注 2' })).not.toBeInTheDocument()
    expect(canvas).toBeInTheDocument()
  })

  it('keeps single deletion in the selected annotation toolbar', async () => {
    const user = userEvent.setup()
    const point: ImageAnnotation = {
      id: 'boot',
      number: 2,
      kind: 'point',
      points: [{ x: 0.8, y: 0.2 }],
    }
    await renderWithProviders(<Editor initial={[original, point]} />)
    loadImage()
    fireEvent.keyDown(screen.getByRole('button', { name: '标注 1' }), { key: 'Enter' })
    await user.click(screen.getByRole('button', { name: '删除此标注' }))
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标注 2' })).toBeInTheDocument()
  })

  it('stops adding marks at the limit with the same hint the draft check uses', async () => {
    const marks = Array.from({ length: MAX_ANNOTATIONS }, (_, index): ImageAnnotation => ({
      id: `mark-${index}`,
      number: index + 1,
      kind: 'point',
      points: [{ x: 0.1, y: 0.1 }],
    }))
    await renderWithProviders(
      <>
        <Editor initial={marks} />
        <Toaster />
      </>,
    )
    const canvas = loadImage()
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 600, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 600, button: 0 })

    expect(await screen.findByText(TOO_MANY_ANNOTATIONS)).toBeVisible()
    expect(
      screen.queryByRole('button', { name: `标注 ${MAX_ANNOTATIONS + 1}` }),
    ).not.toBeInTheDocument()
  })
})
