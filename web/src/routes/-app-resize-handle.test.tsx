/** 拖柄仅验证位移和回调顺序；宽度边界与持久化由应用壳负责。 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppResizeHandle } from './-app-resize-handle'

const renderHandle = () => {
  const calls: string[] = []
  const deltas: number[] = []
  const inputs: string[] = []
  const { unmount } = render(
    <AppResizeHandle
      label="调整侧边栏宽度"
      max={400}
      min={200}
      onReset={() => calls.push('reset')}
      onResize={(delta, input) => {
        calls.push('resize')
        deltas.push(delta)
        inputs.push(input)
      }}
      onResizeEnd={() => calls.push('end')}
      onResizeCancel={() => calls.push('cancel')}
      onResizeStart={() => calls.push('start')}
      value={264}
    />,
  )
  return {
    calls,
    deltas,
    inputs,
    handle: screen.getByRole('button', { name: '调整侧边栏宽度' }),
    unmount,
  }
}

describe('AppResizeHandle', () => {
  it('按下之后跟着指针走，松开报一次结束', () => {
    const { calls, deltas, inputs, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 340 })
    fireEvent.pointerMove(window, { clientX: 260 })
    fireEvent.pointerUp(window)

    expect(deltas).toEqual([40, -40])
    expect(inputs).toEqual(['pointer', 'pointer'])
    expect(calls).toEqual(['start', 'resize', 'resize', 'end'])
  })

  it.each(['pointercancel', 'escape', 'blur'])('%s 取消拖动，不提交新宽度', (reason) => {
    const { calls, deltas, handle } = renderHandle()
    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 340 })
    if (reason === 'pointercancel') fireEvent.pointerCancel(window)
    else if (reason === 'blur') fireEvent.blur(window)
    else fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerMove(window, { clientX: 500 })
    fireEvent.pointerUp(window)
    expect(deltas).toEqual([40])
    expect(calls).toEqual(['start', 'resize', 'cancel'])
  })

  it('松开之后指针再动也不跟了', () => {
    const { deltas, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerUp(window)
    fireEvent.pointerMove(window, { clientX: 500 })

    expect(deltas).toEqual([])
  })

  it('右键不起拖：拖动只认左键', () => {
    const { calls, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 2, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 400 })

    expect(calls).toEqual([])
  })

  it('双击是恢复默认宽', async () => {
    const { calls, handle } = renderHandle()

    await userEvent.dblClick(handle)

    expect(calls).toContain('reset')
  })

  it('左右方向键各调一步，键盘也能改宽', () => {
    const { calls, deltas, inputs, handle } = renderHandle()

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'Enter' })

    expect(deltas).toEqual([16, -16])
    expect(inputs).toEqual(['keyboard', 'keyboard'])
    expect(calls).toEqual(['start', 'resize', 'end', 'start', 'resize', 'end'])
  })

  it('拖到一半被卸载也不再跟着指针跑', () => {
    const { deltas, handle, unmount } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    unmount()
    fireEvent.pointerMove(window, { clientX: 400 })

    expect(deltas).toEqual([])
  })

  it('连按两次拖柄只留一组监听，松开后不再跟着指针跑', () => {
    const { deltas, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerDown(handle, { button: 0, clientX: 320 })
    fireEvent.pointerUp(window)
    fireEvent.pointerMove(window, { clientX: 500 })

    expect(deltas).toEqual([])
  })
})
