import { describe, expect, it } from 'vitest'
import { hitAt, isShown, ownerOf, paintedBounds, painterAt } from './painted-bounds'

// jsdom 不排版：叠放次序由用例直接给出，元素的范围逐个指定；看得见与否、画没画东西按行内样式算。

const win = window
const POINT = { x: 50, y: 50 }

/** 搭一份合成页片段，返回按 id 取元素的函数 */
const page = (html: string) => {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.replaceChildren(root)
  return (id: string) => {
    const element = root.querySelector(`#${id}`)
    if (element === null) throw new Error(`没有 #${id}`)
    return element
  }
}

const rect = (element: Element, left: number, top: number, width: number, height: number) => {
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: left, y: top, width, height })
}

/** 只认这几个草稿 id 与 caption:0 */
const OURS = new Set(['v1', 'o1', 'caption:0'])
const resolve = (hfId: string) => (OURS.has(hfId) ? hfId : undefined)

describe('isShown', () => {
  it('自己或任一祖先 opacity 为 0、visibility 为 hidden、不显示都算看不见', () => {
    const $ = page(`
      <div id="faded" style="opacity:0"><span id="inFaded">字</span></div>
      <div id="hidden" style="visibility:hidden"><span id="inHidden">字</span></div>
      <div id="none" style="display:none"><span id="inNone">字</span></div>
      <div id="half" style="opacity:0.5"><span id="inHalf">字</span></div>`)
    expect(['inFaded', 'inHidden', 'inNone'].map((id) => isShown($(id), win))).toEqual([
      false,
      false,
      false,
    ])
    expect(isShown($('inHalf'), win)).toBe(true)
  })
})

describe('画面点选的命中', () => {
  it('铺满画面的透明特效宿主不接点击，穿过去命中底下的视频段', () => {
    const $ = page(`
      <div id="stage" style="background:black">
        <video id="clip" data-hf-id="v1"></video>
        <div id="overlayHost" class="fill" data-hf-id="o1"><div id="wrapper"></div></div>
      </div>`)
    const stack = [$('wrapper'), $('overlayHost'), $('clip'), $('stage')]
    expect(painterAt(stack, win, POINT)).toBe($('clip'))
    expect(hitAt(stack, win, POINT, resolve)).toBe('v1')
  })

  it('特效里画了东西的字命中那一块特效；组件自带的 data-hf-id 跳过，接着往上找', () => {
    const $ = page(`
      <video id="clip" data-hf-id="v1"></video>
      <div id="overlayHost" data-hf-id="o1">
        <div id="card" data-hf-id="hf-inner"><span id="name">林夏</span></div>
      </div>`)
    const stack = [$('name'), $('card'), $('overlayHost'), $('clip')]
    expect(hitAt(stack, win, POINT, resolve)).toBe('o1')
    expect(ownerOf($('name'), resolve)?.element).toBe($('overlayHost'))
  })

  it('看不见的字（淡出的字幕句）跳过，命中后面画了东西的', () => {
    const $ = page(`
      <video id="clip" data-hf-id="v1"></video>
      <div data-hf-id="caption:0" style="opacity:0"><span id="line">夜色里</span></div>`)
    expect(hitAt([$('line'), $('clip')], win, POINT, resolve)).toBe('v1')
  })

  it('最上面画了东西的元素不属于任何一块（黑底舞台）时没有命中，不再往下找', () => {
    const $ = page(`
      <div id="stage" style="background:black"></div>
      <video id="clip" data-hf-id="v1"></video>`)
    expect(hitAt([$('stage'), $('clip')], win, POINT, resolve)).toBeNull()
    expect(hitAt([], win, POINT, resolve)).toBeNull()
  })
})

describe('paintedBounds', () => {
  const FRAME = { width: 1080, height: 1920 }

  it('框住看得见、画了东西的部分；铺满画面又没画东西的外层盒子、看不见的部分不算', () => {
    const $ = page(`
      <div id="host" data-hf-id="o1">
        <div id="card" style="background:white"><span id="name">林夏</span></div>
        <span id="role">主理人</span>
        <div id="glow" style="background:red;opacity:0"></div>
      </div>`)
    rect($('host'), 0, 0, 1080, 1920)
    rect($('card'), 100, 1500, 400, 120)
    rect($('name'), 120, 1510, 200, 60)
    rect($('role'), 120, 1630, 300, 40)
    rect($('glow'), 0, 0, 1080, 1920)
    expect(paintedBounds([$('host')], win, FRAME)).toEqual({
      left: 100,
      top: 1500,
      width: 400,
      height: 170,
    })
  })

  it('几处元素合起来（质感字幕每个词都带同一句的标记），超出画面的部分裁掉', () => {
    const $ = page(`
      <span id="a" data-hf-id="caption:0">夜色</span>
      <span id="b" data-hf-id="caption:0">里</span>`)
    rect($('a'), -40, 800, 300, 100)
    rect($('b'), 900, 820, 300, 100)
    expect(paintedBounds([$('a'), $('b')], win, FRAME)).toEqual({
      left: 0,
      top: 800,
      width: 1080,
      height: 120,
    })
  })

  it('视频段画的是整个画面；一处画了东西的也没有时为 null', () => {
    const $ = page(`
      <video id="clip" data-hf-id="v1"></video>
      <div id="empty" class="fill"><div id="inner"></div></div>`)
    rect($('clip'), 0, 0, 1080, 1920)
    rect($('empty'), 0, 0, 1080, 1920)
    rect($('inner'), 0, 0, 1080, 1920)
    expect(paintedBounds([$('clip')], win, FRAME)).toEqual({
      left: 0,
      top: 0,
      width: 1080,
      height: 1920,
    })
    expect(paintedBounds([$('empty')], win, FRAME)).toBeNull()
    expect(paintedBounds([], win, FRAME)).toBeNull()
  })
})
