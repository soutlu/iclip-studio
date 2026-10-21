/**
 * 测试用的 `<hyperframes-player>`：jsdom 跑不了真播放器（iframe 里的合成运行时），这里只保留编辑器
 * 用到的接口与事件。设了 srcdoc 后依次发 `ready`、`painted`；play / pause / seek 更新公开状态并发对应的事件。
 * 跳转同真运行时：按 30 帧向下取整到帧，报回那一帧的时刻。
 */

const FPS = 30

class FakeHyperframesPlayer extends HTMLElement {
  static readonly observedAttributes = ['srcdoc']
  currentTime = 0
  paused = true
  painted = false
  rangeStart: number | null = null
  rangeEnd: number | null = null

  attributeChangedCallback(name: string) {
    if (name !== 'srcdoc') return
    this.painted = false
    queueMicrotask(() => {
      this.dispatchEvent(new CustomEvent('ready', { detail: {} }))
      this.painted = true
      this.dispatchEvent(new Event('painted'))
    })
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
