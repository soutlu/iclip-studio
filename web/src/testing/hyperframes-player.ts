/**
 * 测试用的 `<hyperframes-player>`：jsdom 跑不了真播放器（iframe 里的合成运行时），这里只保留编辑器
 * 用到的接口与事件。设了 srcdoc 后依次发 `ready`、`painted`；play / pause / seek 更新公开状态并发对应的事件。
 * 跳转同真运行时：按 30 帧向下取整到帧，报回那一帧的时刻。合成页只把 `<video>` 放进 iframe，别的不执行。
 */

const FPS = 30
const NETWORK_LOADING = 2

/** 还在下载的视频地址；放进去的地址，合成页里对应的视频报 NETWORK_LOADING。 */
export const downloadingVideos = new Set<string>()

/** 这个地址下载停下：从 `downloadingVideos` 拿掉，合成页里对应的视频发 suspend。 */
export const stopVideoDownload = (url: string) => {
  downloadingVideos.delete(url)
  for (const player of document.querySelectorAll<FakeHyperframesPlayer>('hyperframes-player'))
    for (const video of player.iframeElement.contentDocument?.querySelectorAll('video') ?? [])
      if (video.getAttribute('src') === url) video.dispatchEvent(new Event('suspend'))
}

class FakeHyperframesPlayer extends HTMLElement {
  static readonly observedAttributes = ['srcdoc']
  readonly iframeElement = document.createElement('iframe')
  currentTime = 0
  paused = true
  painted = false

  connectedCallback() {
    this.append(this.iframeElement)
  }

  attributeChangedCallback(name: string, _old: string | null, srcdoc: string | null) {
    if (name !== 'srcdoc') return
    this.painted = false
    this.#showVideos(srcdoc ?? '')
    queueMicrotask(() => {
      this.dispatchEvent(new CustomEvent('ready', { detail: {} }))
      this.painted = true
      this.dispatchEvent(new Event('painted'))
    })
  }

  #showVideos(srcdoc: string) {
    const page = this.iframeElement.contentDocument
    if (page === null) return
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html')
    page.body.replaceChildren(
      ...[...parsed.querySelectorAll('video')].map((source) => {
        const video = page.importNode(source)
        Object.defineProperty(video, 'networkState', {
          get: () =>
            downloadingVideos.has(source.getAttribute('src') ?? '') ? NETWORK_LOADING : 0,
        })
        return video
      }),
    )
  }

  play() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

  pause() {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  seek(seconds: number) {
    this.currentTime = Math.floor(seconds * FPS) / FPS
    this.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: this.currentTime } }))
  }
}

if (customElements.get('hyperframes-player') === undefined)
  customElements.define('hyperframes-player', FakeHyperframesPlayer)
