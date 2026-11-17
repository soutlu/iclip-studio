import { describe, expect, it } from 'vitest'
import { canvasLayersOf } from './canvas-layers'

const main = `<!doctype html><html><head></head><body>
<div id="film" data-hf-id="film" data-composition-id="film" data-width="1080" data-height="1920">
<video id="clip-v" data-hf-id="clip-v" class="clip picture" data-start="0" data-duration="2"></video>
<audio id="clip-a" data-hf-id="clip-a" class="clip audio" data-start="0" data-duration="2"></audio>
<div id="clip-h" data-hf-id="clip-h" class="clip component" data-composition-id="card" data-composition-src="compositions/card.html"></div>
<div id="clip-g" data-hf-id="clip-g" class="clip component" data-composition-id="gone" data-composition-src="compositions/gone.html"></div>
<div id="captions" data-hf-id="captions" data-track-kind="captions" data-composition-id="captions" data-composition-src="compositions/captions.html"></div>
</div></body></html>`

// 完整网页写法的组件：根下一个面板，里面两个同 class 的字、一个没有 id 和 class 的装饰；一块锁定的区域；一段脚本
const card = `<!doctype html><html><head><style>.x{}</style></head><body>
<div id="root" data-hf-id="hf-root" data-composition-id="card">
  <div id="panel" data-hf-id="hf-panel">
    <span class="word" data-hf-id="hf-w1">一</span>
    <span class="word" data-hf-id="hf-w2">二</span>
    <i data-hf-id="hf-plain"></i>
  </div>
  <div class="locked-area" data-timeline-locked data-hf-id="hf-lock"><b class="inside" data-hf-id="hf-in"></b></div>
  <script data-hf-id="hf-script"></script>
</div></body></html>`

const scene = `<template>
<div id="root" data-hf-id="root" data-composition-id="captions">
<div id="cap-1" data-hf-id="cap-1" class="clip caption">第一句</div>
<div id="cap-2" data-hf-id="cap-2" class="clip caption">第二句</div>
</div>
</template>`

const mounts = [
  { host: 'clip-h', file: 'compositions/card.html', captions: false },
  { host: 'clip-g', file: 'compositions/gone.html', captions: false },
  { host: 'captions', file: 'compositions/captions.html', captions: true },
]

const layers = canvasLayersOf(
  main,
  mounts,
  new Map([
    ['compositions/card.html', card],
    ['compositions/captions.html', scene],
  ]),
)

/** 挂在 `scope` 下的层，写成「选择器、第几个、一共几个、文件、片段、宿主、锁定、文件里的编号」。 */
const under = (scope: string | null) =>
  layers
    .filter((layer) => layer.scope === scope)
    .map((layer) => [
      layer.selector,
      layer.index,
      layer.count,
      layer.file,
      layer.clip,
      layer.host,
      layer.locked,
      layer.element.hfId,
    ])

const CARD = 'compositions/card.html'
const SCENE = 'compositions/captions.html'

describe('画面上的层', () => {
  it('主文件里：视频片段是一层，组件或块的宿主只列成宿主；音频、字幕宿主、根都不是层', () => {
    expect(under(null)).toEqual([
      ['#clip-v', 0, 1, 'index.html', 'clip-v', false, false, 'clip-v'],
      ['#clip-h', 0, 1, 'index.html', 'clip-h', true, false, 'clip-h'],
      ['#clip-g', 0, 1, 'index.html', 'clip-g', true, false, 'clip-g'],
    ])
  })

  it('组件文件里的层属于它的宿主，写进组件文件；同一个 class 按文件里的先后数第几个；锁定区域里的都锁定', () => {
    expect(under('clip-h')).toEqual([
      ['#panel', 0, 1, CARD, 'clip-h', false, false, 'hf-panel'],
      ['.word', 0, 2, CARD, 'clip-h', false, false, 'hf-w1'],
      ['.word', 1, 2, CARD, 'clip-h', false, false, 'hf-w2'],
      ['.locked-area', 0, 1, CARD, 'clip-h', false, true, 'hf-lock'],
      ['.inside', 0, 1, CARD, 'clip-h', false, true, 'hf-in'],
    ])
  })

  it('字幕场景里每一句是一层，属于这一句；挂载的文件没打开时那个宿主下没有层', () => {
    expect(under('captions')).toEqual([
      ['#cap-1', 0, 1, SCENE, 'cap-1', false, false, 'cap-1'],
      ['#cap-2', 0, 1, SCENE, 'cap-2', false, false, 'cap-2'],
    ])
    expect(under('clip-g')).toEqual([])
  })

  it('每一层的名字由宿主、选择器和第几个连起来，各不相同', () => {
    expect(new Set(layers.map((layer) => layer.key)).size).toBe(layers.length)
  })
})
