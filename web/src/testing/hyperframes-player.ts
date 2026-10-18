/**
 * 测试用的 `<hyperframes-player>`：jsdom 跑不了真播放器（iframe 里的合成运行时），这里只保留编辑器
 * 用到的接口与事件。设了 srcdoc 后依次发 `ready`、`painted`；play / pause / seek 发对应的事件，
 * `playerCalls` 记下调用。
 */

export const playerCalls: string[] = []

class FakeHyperframesPlayer extends HTMLElement {
  static readonly observedAttributes = ['srcdoc']
  currentTime = 0
  paused = true
  painted = false

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
    playerCalls.push('play')
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

  pause() {
    playerCalls.push('pause')
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  seek(seconds: number) {
    playerCalls.push(`seek ${seconds}`)
    this.currentTime = seconds
    this.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: seconds } }))
  }
}

if (customElements.get('hyperframes-player') === undefined)
  customElements.define('hyperframes-player', FakeHyperframesPlayer)
