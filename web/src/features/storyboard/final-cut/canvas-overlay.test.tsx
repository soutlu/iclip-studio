import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { fixtureCatalog, video } from '@/testing/final-cut'
import { CanvasOverlay } from './canvas-overlay'
import type { CanvasLayer } from './canvas-layers'
import { SOURCE_SHOWN } from './locales'
import type { PickedLayer, PreviewControl } from './preview-player'

// 画面上只有一层：铺满画面的视频片段
const VIDEO = video({ duration: 2_000 })
const LAYER: CanvasLayer = {
  key: 'clip-1',
  scope: null,
  selector: '#clip-1',
  index: 0,
  count: 1,
  file: 'index.html',
  clip: VIDEO.id,
  host: false,
  locked: false,
  element: { hfId: VIDEO.id, tag: 'video', attributes: {} },
}
const UNDER_POINTER: PickedLayer = {
  layer: 0,
  field: null,
  measure: {
    frame: { cx: 360, cy: 640, width: 720, height: 1280, angle: 0 },
    visible: { cx: 360, cy: 640, width: 720, height: 1280, angle: 0 },
    width: 720,
    height: 1280,
    parent: { a: 1, b: 0, c: 0, d: 1 },
    rotate: 0,
    translating: false,
    inline: false,
    flex: 0,
    move: true,
    resize: true,
    turn: true,
    refusal: 0,
  },
}

/** 预览页的替身：问指针下是哪一层时答这一层，别的什么都不做。 */
const preview: PreviewControl = {
  play: () => {},
  pause: () => {},
  seek: () => {},
  pick: () => Promise.resolve([UNDER_POINTER]),
  snapRects: () => Promise.resolve(null),
  draft: () => Promise.resolve(null),
  draftEnd: () => {},
  editText: () => {},
  endText: () => {},
}

it('停着时指针移到画面上的一层：在它周围画一圈细框', async () => {
  render(
    <CanvasOverlay
      bindings={new Map()}
      canvas={{ width: 720, height: 1280 }}
      catalog={fixtureCatalog}
      clips={[VIDEO]}
      contentOf={() => undefined}
      controlRef={{ current: preview }}
      frameMs={500}
      layers={[LAYER]}
      locale={SOURCE_SHOWN}
      measures={new Map()}
      nudgeRef={{ current: null }}
      onCaptionText={() => {}}
      onEdit={() => {}}
      onGesture={() => {}}
      onNotice={() => {}}
      onSelect={() => {}}
      onText={() => {}}
      onTextClose={() => {}}
      onWatch={() => {}}
      playing={false}
      revision={0}
      selected={new Set()}
      textTarget={null}
    />,
  )
  fireEvent.pointerMove(screen.getByRole('group', { name: '预览画面' }), {
    clientX: 20,
    clientY: 20,
  })
  expect(await screen.findByTestId('canvas-hover')).toBeInTheDocument()
})
