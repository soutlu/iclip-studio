import { describe, expect, it } from 'vitest'
import { shotAfterArrowKey } from './use-shot-arrow-keys'

const press = (key: string, target: EventTarget | null = document.body, extra = {}) => ({
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  key,
  metaKey: false,
  shiftKey: false,
  target,
  ...extra,
})

const inside = (html: string) => {
  const host = document.createElement('div')
  host.innerHTML = html
  const target = host.querySelector('[data-target]')
  if (target === null) throw new Error('缺少 data-target')
  return target
}

describe('shotAfterArrowKey', () => {
  it('↓ 下一组、↑ 上一组，到头不动', () => {
    expect(shotAfterArrowKey(press('ArrowDown'), 1, 3)).toBe(2)
    expect(shotAfterArrowKey(press('ArrowUp'), 2, 3)).toBe(1)
    expect(shotAfterArrowKey(press('ArrowDown'), 3, 3)).toBeUndefined()
    expect(shotAfterArrowKey(press('ArrowUp'), 1, 3)).toBeUndefined()
  })

  it('别的键、带修饰键或已被处理的按键不切', () => {
    expect(shotAfterArrowKey(press('ArrowRight'), 1, 3)).toBeUndefined()
    expect(shotAfterArrowKey(press('ArrowDown', document.body, { shiftKey: true }), 1, 3)).toBe(
      undefined,
    )
    expect(
      shotAfterArrowKey(press('ArrowDown', document.body, { defaultPrevented: true }), 1, 3),
    ).toBeUndefined()
  })

  it.each([
    ['正在编辑的正文', '<div contenteditable="true"><span data-target>字</span></div>'],
    ['输入框', '<input data-target />'],
    ['下拉', '<select data-target></select>'],
    ['菜单按钮', '<button aria-haspopup="menu" data-target>视频模型</button>'],
    ['单选组', '<div role="radiogroup"><button data-target>720p</button></div>'],
    ['弹窗', '<div role="dialog"><button data-target>关联</button></div>'],
  ])('焦点在%s里时方向键归它自己', (_, html) => {
    expect(shotAfterArrowKey(press('ArrowDown', inside(html)), 1, 3)).toBeUndefined()
  })

  it('只读正文里的方向键照样切组', () => {
    const target = inside('<div contenteditable="false" data-target>只读</div>')
    expect(shotAfterArrowKey(press('ArrowDown', target), 1, 3)).toBe(2)
  })
})
