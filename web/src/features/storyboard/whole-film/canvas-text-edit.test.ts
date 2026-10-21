import { describe, expect, it, vi } from 'vitest'
import { card, draftOf, expectOk, overlay, video } from '@/testing/whole-film'
import { captionTextEdit, componentTextEdit, startTextEdit } from './canvas-text-edit'
import type { PlacedCaption } from './composition/captions'

const CAPTION: PlacedCaption = {
  clipId: 'v1',
  subtitleJobId: 'sub1',
  sentenceIndex: 2,
  start: 0,
  end: 1_000,
  text: '夜色里',
  words: [],
}

const film = () =>
  draftOf([video('v1', 'job', 0, 3_000), card('c1', 2_000, { variables: { title: '片头' } })], {
    overlays: [overlay('o1', 0, 1_000, { variables: { name: '林夏', role: '主理人' } })],
  })

describe('captionTextEdit', () => {
  const edit = (text: string, current = '夜色里，城市亮起来') =>
    captionTextEdit(film(), { caption: CAPTION, text, current, recognized: '夜色里，城市亮起来' })

  it('改了字就记这一句的新字（去掉首尾空白）', () => {
    expect(expectOk(edit('  夜色里，灯亮了 ') ?? fail()).draft.captions.edits).toEqual([
      { subtitleJobId: 'sub1', sentenceIndex: 2, text: '夜色里，灯亮了' },
    ])
  })

  it('没变不记编辑', () => {
    expect(edit(' 夜色里，城市亮起来 ')).toBeNull()
    expect(edit('夜色里，灯亮了', '夜色里，灯亮了')).toBeNull()
  })

  it('清空或改回识别结果时撤掉改字', () => {
    const edited = { subtitleJobId: 'sub1', sentenceIndex: 2, text: '改过' }
    const draft = { ...film(), captions: { component: 'default-caption', edits: [edited] } }
    for (const text of ['', '夜色里，城市亮起来']) {
      const result = captionTextEdit(draft, {
        caption: CAPTION,
        text,
        current: '改过',
        recognized: '夜色里，城市亮起来',
      })
      expect(expectOk(result ?? fail()).draft.captions.edits).toEqual([])
    }
  })
})

describe('componentTextEdit', () => {
  it('只换改的那一项，其余可填项照旧；特效块与画面轨上的组件段都行', () => {
    const named = componentTextEdit(film(), {
      id: 'o1',
      variable: 'name',
      text: ' 陈默 ',
      shown: '林夏',
    })
    expect(expectOk(named ?? fail()).draft.overlays[0]?.variables).toEqual({
      name: '陈默',
      role: '主理人',
    })
    const titled = componentTextEdit(film(), {
      id: 'c1',
      variable: 'subtitle',
      text: '第一集',
      shown: '副标题',
    })
    expect(expectOk(titled ?? fail()).draft.layer0[1]).toMatchObject({
      variables: { title: '片头', subtitle: '第一集' },
    })
  })

  it('没变（只差首尾空白）不记编辑', () => {
    expect(
      componentTextEdit(film(), { id: 'o1', variable: 'name', text: '林夏 ', shown: '林夏' }),
    ).toBeNull()
  })

  it('清空时去掉这一项，回到组件的默认字', () => {
    const cleared = componentTextEdit(film(), {
      id: 'o1',
      variable: 'role',
      text: '  ',
      shown: '主理人',
    })
    expect(expectOk(cleared ?? fail()).draft.overlays[0]?.variables).toEqual({ name: '林夏' })
  })
})

const fail = (): never => {
  throw new Error('应当记一步编辑')
}

/** 一句高亮字幕：每个词一个元素，词后面有不带字的底块 */
const highlightGroup = () => {
  const group = document.createElement('div')
  group.setAttribute('data-hf-id', 'caption:0')
  group.innerHTML =
    '<span class="w"><span class="bg"></span><span class="t">夜色</span></span>' +
    '<span class="w"><span class="bg"></span><span class="t">里</span></span>'
  document.body.replaceChildren(group)
  return group
}

/** 像浏览器里打字那样就地改掉元素里的文字节点 */
const typeInto = (element: Element, text: string) => {
  const node = element.firstChild
  if (!(node instanceof Text)) throw new Error('元素里没有文字')
  node.data = text
}

const press = (element: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

describe('startTextEdit', () => {
  it('字幕换成整句、拿掉其余逐词元素再改；回车提交，写进草稿时保持改后的样子', () => {
    const group = highlightGroup()
    const onCommit = vi.fn(() => true)
    const onEnd = vi.fn()
    startTextEdit(group, { text: '夜色里，城市亮起来', onCommit, onEnd })
    const target = group.querySelector('.t')
    expect(target?.getAttribute('contenteditable')).toBe('plaintext-only')
    expect(group.querySelectorAll('.w')).toHaveLength(1)
    expect(group.querySelector('.bg')).not.toBeNull()
    expect(group.textContent).toBe('夜色里，城市亮起来')

    if (target === null) throw new Error('没有放字的元素')
    typeInto(target, '夜色里，灯亮了')
    expect(press(target, 'Enter').defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenCalledWith('夜色里，灯亮了')
    expect(onEnd).toHaveBeenCalledOnce()
    expect(target.hasAttribute('contenteditable')).toBe(false)
    expect(group.textContent).toBe('夜色里，灯亮了')
  })

  it('Esc 放弃：恢复原来的逐词元素与样式，不往外传，也不提交', () => {
    const group = highlightGroup()
    const before = group.innerHTML
    const onCommit = vi.fn(() => true)
    const outer = vi.fn()
    document.body.addEventListener('keydown', outer)
    startTextEdit(group, { text: '整句', onCommit, onEnd: vi.fn() })
    const target = group.querySelector('.t')
    if (target === null) throw new Error('没有放字的元素')
    typeInto(target, '改了一半')
    press(target, 'Escape')
    document.body.removeEventListener('keydown', outer)
    expect(outer).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(group.innerHTML).toBe(before)
  })

  it('改组件的字：Esc 放弃后恢复原来的字', () => {
    document.body.innerHTML = '<span data-var-text="name">林夏</span>'
    const name = document.querySelector('span')
    if (name === null) throw new Error('没有元素')
    const onCommit = vi.fn(() => true)
    startTextEdit(name, { onCommit, onEnd: vi.fn() })
    typeInto(name, '陈默')
    press(name, 'Escape')
    expect(onCommit).not.toHaveBeenCalled()
    expect(name.outerHTML).toBe('<span data-var-text="name">林夏</span>')
  })

  it('失焦也提交；没写进草稿时恢复原样', () => {
    document.body.innerHTML = '<span data-var-text="name" style="color: red;">林夏</span>'
    const name = document.querySelector('span')
    if (name === null) throw new Error('没有元素')
    const onCommit = vi.fn(() => false)
    const onEnd = vi.fn()
    startTextEdit(name, { onCommit, onEnd })
    expect(name.style.getPropertyValue('caret-color')).not.toBe('')
    typeInto(name, '陈默')
    name.dispatchEvent(new FocusEvent('blur'))
    expect(onCommit).toHaveBeenCalledWith('陈默')
    expect(onEnd).toHaveBeenCalledOnce()
    expect(name.outerHTML).toBe('<span data-var-text="name" style="color: red;">林夏</span>')
  })

  it('Shift+回车与输入法组字中的回车不提交', () => {
    document.body.innerHTML = '<span>林夏</span>'
    const name = document.querySelector('span')
    if (name === null) throw new Error('没有元素')
    const onCommit = vi.fn(() => true)
    startTextEdit(name, { onCommit, onEnd: vi.fn() })
    press(name, 'Enter', { shiftKey: true })
    press(name, 'Enter', { isComposing: true })
    expect(onCommit).not.toHaveBeenCalled()
  })
})
