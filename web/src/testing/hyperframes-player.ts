import { HYPERFRAME_RUNTIME_GLOBALS } from '@hyperframes/core'

const FPS = 30
const NETWORK_LOADING = 2

export const downloadingVideos = new Set<string>()

export const starvedVideos = new Set<string>()

export const bufferedVideos = new Map<string, readonly (readonly [number, number])[]>()

const failedVideos = new Set<string>()

export const emitFrom = (url: string, type: string) => {
  for (const player of document.querySelectorAll<FakeHyperframesPlayer>('hyperframes-player'))
    for (const video of player.iframeElement.contentDocument?.querySelectorAll('video') ?? [])
      if (video.getAttribute('src') === url) video.dispatchEvent(new Event(type))
}

export const stopVideoDownload = (url: string) => {
  downloadingVideos.delete(url)
  emitFrom(url, 'suspend')
}

export const finishBuffering = (url: string) => {
  starvedVideos.delete(url)
  bufferedVideos.set(url, [[0, Number.MAX_SAFE_INTEGER]])
  emitFrom(url, 'progress')
}

export const failVideo = (url: string) => {
  failedVideos.add(url)
  emitFrom(url, 'error')
}

export const clearFailedVideos = () => failedVideos.clear()

export class FakeParentMedia {
  readonly entries: string[] = []

  _createEntry(url: string): string | null {
    this.entries.push(url)
    return url
  }

  setupFromIframe(page: Document) {
    for (const video of page.querySelectorAll('video[data-start]'))
      this._createEntry(video.getAttribute('src') ?? '')
  }
}

class FakeHyperframesPlayer extends HTMLElement {
  static readonly observedAttributes = ['srcdoc']
  readonly iframeElement = document.createElement('iframe')
  readonly _media = new FakeParentMedia()
  currentTime = 0
  // 默认设置足够长时长避免误触发播完；需测试播完边界的用例可自行改短
  duration = 3600
  paused = true
  painted = false
  playbackRate = 1
  muted = false
  loop = false
  /** 记录接收到 `srcdoc` 瞬间读取到的 `runtime-src` 属性值，模拟真实播放器注入运行库脚本的时机。 */
  loadedRuntimeSrc: string | null = null
  /**
   * 播放器内部运行库时钟时刻（秒）：真实播放器播放时逐帧递增，此处由测试用例手动改写模拟，调用 `seek` 时同步更新。
   * 仅在文档加载就绪后挂载至 iframe 全局对象（与运行库行为一致）；用例删除该全局属性可模拟时钟缺失场景。
   */
  runtimeTime = 0

  connectedCallback() {
    this.append(this.iframeElement)
  }

  attributeChangedCallback(name: string, _old: string | null, srcdoc: string | null) {
    if (name !== 'srcdoc') return
    this.loadedRuntimeSrc = this.getAttribute('runtime-src')
    this.painted = false
    this.#showFilm(srcdoc ?? '')
    queueMicrotask(() => {
      const page = this.iframeElement.contentDocument
      if (page !== null) this._media.setupFromIframe(page)
      const view = this.iframeElement.contentWindow
      if (view !== null)
        Reflect.set(view, HYPERFRAME_RUNTIME_GLOBALS.player, { getTime: () => this.runtimeTime })
      this.dispatchEvent(new CustomEvent('ready', { detail: {} }))
      this.painted = true
      this.dispatchEvent(new Event('painted'))
    })
  }

  /** 将 final-cut 的 `<body>` 节点导入 iframe（供增量补丁按 `data-hf-id` 定位），视频加载状态由模块级测试集合控制。 */
  #showFilm(srcdoc: string) {
    const page = this.iframeElement.contentDocument
    if (page === null) return
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html')
    page.body.replaceChildren(
      ...[...parsed.body.childNodes].map((node) => page.importNode(node, true)),
    )
    for (const video of page.querySelectorAll('video')) {
      const url = video.getAttribute('src') ?? ''
      Object.defineProperties(video, {
        networkState: { get: () => (downloadingVideos.has(url) ? NETWORK_LOADING : 0) },
        readyState: {
          get: () =>
            starvedVideos.has(url)
              ? HTMLMediaElement.HAVE_METADATA
              : HTMLMediaElement.HAVE_ENOUGH_DATA,
        },
        error: { get: () => (failedVideos.has(url) ? { code: 4 } : null) },
        buffered: {
          get: () => {
            const ranges = bufferedVideos.get(url) ?? []
            return {
              length: ranges.length,
              start: (at: number) => ranges[at]?.[0],
              end: (at: number) => ranges[at]?.[1],
            }
          },
        },
      })
    }
  }

  play() {
    if (this.currentTime >= this.duration) {
      this.currentTime = 0
      this.runtimeTime = 0
    }
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  seek(seconds: number) {
    this.currentTime = Math.floor(seconds * FPS) / FPS
    this.runtimeTime = this.currentTime
    this.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: this.currentTime } }))
  }
}

if (customElements.get('hyperframes-player') === undefined)
  customElements.define('hyperframes-player', FakeHyperframesPlayer)
