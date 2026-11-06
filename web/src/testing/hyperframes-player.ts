/**
 * 测试用的 `<hyperframes-player>`：jsdom 跑不了真播放器（iframe 里的合成运行时），这里只保留编辑器
 * 用到的接口与事件。设了 srcdoc 后依次发 `ready`、`painted`；play / pause / seek 更新公开状态并发对应的事件。
 * 跳转同真运行时：按 30 帧向下取整到帧，报回那一帧的时刻。合成页只把 `<video>` 放进 iframe，别的不执行。
 */

const FPS = 30
const NETWORK_LOADING = 2

/** 还在下载的视频地址；放进去的地址，合成页里对应的视频报 NETWORK_LOADING。 */
export const downloadingVideos = new Set<string>()

/** 数据不够播的视频地址；放进去的地址，合成页里对应的视频报 HAVE_METADATA，否则报 HAVE_ENOUGH_DATA。 */
export const starvedVideos = new Set<string>()

/** 加载出错的视频地址；放进去的地址，合成页里对应的视频带 `error`。 */
const failedVideos = new Set<string>()

const emitFrom = (url: string, type: string) => {
  for (const player of document.querySelectorAll<FakeHyperframesPlayer>('hyperframes-player'))
    for (const video of player.iframeElement.contentDocument?.querySelectorAll('video') ?? [])
      if (video.getAttribute('src') === url) video.dispatchEvent(new Event(type))
}

/** 这个地址下载停下：从 `downloadingVideos` 拿掉，合成页里对应的视频发 suspend。 */
export const stopVideoDownload = (url: string) => {
  downloadingVideos.delete(url)
  emitFrom(url, 'suspend')
}

/** 这个地址数据够了：从 `starvedVideos` 拿掉，合成页里对应的视频发 canplaythrough。 */
export const finishBuffering = (url: string) => {
  starvedVideos.delete(url)
  emitFrom(url, 'canplaythrough')
}

/** 这个地址加载出错：合成页里对应的视频带上 `error` 并发 error。用完用 `clearFailedVideos` 清掉。 */
export const failVideo = (url: string) => {
  failedVideos.add(url)
  emitFrom(url, 'error')
}

export const clearFailedVideos = () => failedVideos.clear()

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
        const url = source.getAttribute('src') ?? ''
        Object.defineProperties(video, {
          networkState: { get: () => (downloadingVideos.has(url) ? NETWORK_LOADING : 0) },
          readyState: {
            get: () =>
              starvedVideos.has(url)
                ? HTMLMediaElement.HAVE_METADATA
                : HTMLMediaElement.HAVE_ENOUGH_DATA,
          },
          error: { get: () => (failedVideos.has(url) ? { code: 4 } : null) },
        })
        return video
      }),
    )
  }

  play() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

  // 同真播放器：已经停着也发 pause
  pause() {
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
