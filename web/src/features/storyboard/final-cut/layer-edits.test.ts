import { describe, expect, it } from 'vitest'
import {
  authoredTransform,
  cssStyles,
  movedTo,
  rotationStyles,
  rotationTarget,
  sizeStyles,
  toLocal,
} from './layer-edits'

describe('挪', () => {
  it('画布上挪的距离换成父元素里的像素：父元素缩小一半、转 90° 时都按它算回去', () => {
    expect(toLocal({ a: 0.5, b: 0, c: 0, d: 0.5 }, { x: 10, y: -20 })).toEqual({ x: 20, y: -40 })
    const turned = toLocal({ a: 0, b: 1, c: -1, d: 0 }, { x: 10, y: 0 })
    expect(turned.x).toBeCloseTo(0)
    expect(turned.y).toBeCloseTo(-10)
    expect(toLocal({ a: 0, b: 0, c: 0, d: 0 }, { x: 10, y: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('写 SDK moveElement 的 data-x / data-y：在元素现在写着的上面加，没写过从 0 加，留三位小数', () => {
    expect(movedTo({}, { x: 12.34567, y: -3 })).toEqual({ x: 12.346, y: -3 })
    expect(movedTo({ 'data-x': '100', 'data-y': '-20.5' }, { x: -100, y: 0.5 })).toEqual({
      x: 0,
      y: -20,
    })
  })
})

describe('缩放', () => {
  it('写宽高（px）、border-box，放开最小最大宽高；不写 scale', () => {
    expect(sizeStyles({ width: 300, height: 120 }, 0, false)).toEqual({
      boxSizing: 'border-box',
      width: '300px',
      height: '120px',
      minWidth: '0px',
      minHeight: '0px',
      maxWidth: 'none',
      maxHeight: 'none',
    })
  })

  it('父元素是竖排的弹性布局：flex-basis 是高度、不伸不缩；行内元素改成行内块', () => {
    expect(sizeStyles({ width: 300, height: 120 }, 2, true)).toMatchObject({
      flexBasis: '120px',
      flexGrow: '0',
      flexShrink: '0',
      display: 'inline-block',
    })
    expect(sizeStyles({ width: 300, height: 120 }, 1, false)).toMatchObject({ flexBasis: '300px' })
  })

  it('给预览页摆的时候换成 CSS 的写法', () => {
    expect(cssStyles({ boxSizing: 'border-box', minWidth: null, '--x': '1' })).toEqual({
      'box-sizing': 'border-box',
      'min-width': null,
      '--x': '1',
    })
  })
})

describe('转', () => {
  it('变换里没有位移：写自己的 rotate，从它现在的度数算起', () => {
    const target = rotationTarget(false, undefined, 12)
    expect(target).toEqual({ property: 'rotate', turn: 12 })
    if (target === null) throw new Error('应该能转')
    expect(rotationStyles(target, 30.12345, false)).toEqual({ rotate: '30.123deg' })
    expect(rotationStyles(target, 0, true)).toEqual({ rotate: '0deg', display: 'inline-block' })
  })

  it('变换以位移开头（居中）：rotate() 插在位移后面，原来插过的换掉，其余跟在后面', () => {
    const target = rotationTarget(true, 'translate(-50%, -50%) rotate(10deg) scale(2)', 0)
    expect(target).toEqual({
      property: 'transform',
      before: 'translate(-50%, -50%)',
      after: 'scale(2)',
      turn: 10,
    })
    if (target === null) throw new Error('应该能转')
    expect(rotationStyles(target, 45, false)).toEqual({
      transform: 'translate(-50%, -50%) rotate(45deg) scale(2)',
    })
    expect(rotationTarget(true, 'translateY(-50%)', 0)).toEqual({
      property: 'transform',
      before: 'translateY(-50%)',
      after: '',
      turn: 0,
    })
  })

  it('变换里有位移但找不到写在哪：不转', () => {
    expect(rotationTarget(true, undefined, 0)).toBeNull()
    expect(rotationTarget(true, 'none', 0)).toBeNull()
  })

  it('按文件里的编号找它写着的变换：先看行内的', () => {
    const content =
      '<template><div data-hf-id="a" style="transform: translateX(-50%)"></div></template>'
    expect(authoredTransform(content, 'a')).toBe('translateX(-50%)')
    expect(authoredTransform(content, 'missing')).toBeUndefined()
  })
})
