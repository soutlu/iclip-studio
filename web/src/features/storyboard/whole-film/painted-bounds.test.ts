import { beforeEach, describe, expect, it, vi } from 'vitest'
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

// jsdom 不排版，Range 量不出字的范围：按文字节点给出字在画面上的范围
const textRects = new WeakMap<Node, DOMRect>()
beforeEach(() => {
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let selected: Node | undefined
    return {
      selectNodeContents: (node: Node) => {
        selected = node
      },
      getClientRects: () => {
        const found = selected === undefined ? undefined : textRects.get(selected)
        return found === undefined ? [] : [found]
      },
    } as unknown as Range
  })
})

/** 元素直接带的那段字在画面上的范围 */
const textRect = (element: Element, left: number, top: number, width: number, height: number) => {
  const node = element.firstChild
  if (node === null) throw new Error('元素里没有字')
  textRects.set(node, DOMRect.fromRect({ x: left, y: top, width, height }))
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
    textRect($('name'), 120, 1510, 80, 60)
    rect($('role'), 120, 1630, 300, 40)
    textRect($('role'), 120, 1630, 90, 40)
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
    for (const [id, left, top] of [
      ['a', -40, 800],
      ['b', 900, 820],
    ] as const) {
      rect($(id), left, top, 300, 100)
      textRect($(id), left, top, 300, 100)
    }
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

  it('块级的字比自己的盒子窄：框贴着字（字幕句组、名牌的名字）', () => {
    const $ = page(`
      <div id="group" data-hf-id="caption:0" style="display:block"><div id="line">夜色里</div></div>`)
    rect($('group'), 0, 1500, 1080, 200)
    rect($('line'), 0, 1550, 1080, 100)
    textRect($('line'), 400, 1560, 280, 80)
    expect(paintedBounds([$('group')], win, FRAME)).toEqual({
      left: 400,
      top: 1560,
      width: 280,
      height: 80,
    })
  })

  it('有底色或边框的盒子仍按盒子算，不按里面的字', () => {
    const $ = page(`
      <div id="plate" style="background:rgb(9 11 15 / 78%)">林夏</div>
      <div id="framed" style="border:2px solid white">主理人</div>`)
    rect($('plate'), 100, 900, 600, 200)
    textRect($('plate'), 140, 940, 120, 60)
    rect($('framed'), 100, 1200, 300, 80)
    textRect($('framed'), 120, 1210, 100, 50)
    expect(paintedBounds([$('plate'), $('framed')], win, FRAME)).toEqual({
      left: 100,
      top: 900,
      width: 600,
      height: 380,
    })
  })

  it('svg 不量整个盒子，量里面填了色或描了边的图形：留白的 viewBox 边距、空路径、defs 里的都不算', () => {
    const $ = page(`
      <div id="host" data-hf-id="o1">
        <svg id="svg" viewBox="0 0 1120 510">
          <defs><path id="defsPath" d="M0 0H1120V510H0z" /></defs>
          <g transform="translate(150,150)">
            <path id="fill" d="M0 0H820V210H0z" style="fill:rgb(9 11 15 / 78%)" />
            <path id="rail" d="" style="fill:none;stroke:none" />
            <path id="faded" d="M0 0H900V300H0z" style="opacity:0" />
          </g>
        </svg>
      </div>`)
    rect($('host'), 0, 0, 1080, 1920)
    rect($('svg'), 0, 600, 1120, 510)
    rect($('defsPath'), 0, 600, 1120, 510)
    rect($('fill'), 150, 750, 820, 210)
    rect($('rail'), 140, 740, 840, 230)
    rect($('faded'), 150, 750, 900, 300)
    expect(paintedBounds([$('host')], win, FRAME)).toEqual({
      left: 150,
      top: 750,
      width: 820,
      height: 210,
    })
  })

  it('svg 里一个画东西的图形都没有时退回整个 svg 盒子', () => {
    const $ = page(`<svg id="svg"><g><path id="empty" d="" /></g></svg>`)
    rect($('svg'), 10, 20, 300, 100)
    rect($('empty'), 0, 0, 0, 0)
    expect(paintedBounds([$('svg')], win, FRAME)).toEqual({
      left: 10,
      top: 20,
      width: 300,
      height: 100,
    })
  })
})
