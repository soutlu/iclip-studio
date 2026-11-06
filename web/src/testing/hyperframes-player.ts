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
  duration = Number.POSITIVE_INFINITY
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
      const page = this.iframeElement.contentDocument
      if (page !== null) this._media.setupFromIframe(page)
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
        return video
      }),
    )
  }

  play() {
    if (this.currentTime >= this.duration) this.currentTime = 0
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

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
