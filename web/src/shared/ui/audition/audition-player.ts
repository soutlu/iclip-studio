type Current = { id: string; url: string }

/** 列表要的那部分：当前是哪一条（在放或暂停着）、是不是暂停着。只在点、放完、停下时变。 */
export type AuditionState = { current: Current | null; paused: boolean }

/**
 * 当前这条的播放进度：已放到的毫秒、总毫秒（还没读到时长时是 null）、在等数据、放不出来。
 * 都从 `<audio>` 元素上读，换一条时不会带着上一条的失败。
 */
export type AuditionProgress = {
  timeMs: number
  durationMs: number | null
  waiting: boolean
  failed: boolean
}

const IDLE_STATE: AuditionState = { current: null, paused: true }

const IDLE_PROGRESS: AuditionProgress = {
  durationMs: null,
  failed: false,
  timeMs: 0,
  waiting: false,
}

const MEDIA_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'durationchange',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'waiting',
  'stalled',
  'pause',
  'seeking',
  'seeked',
  'timeupdate',
  'ended',
  'error',
  'emptied',
] as const

const progressOf = (audio: HTMLAudioElement): AuditionProgress => ({
  durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null,
  failed: audio.error !== null,
  timeMs: Math.round(audio.currentTime * 1000),
  waiting:
    audio.error === null && !audio.paused && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
})

const sameProgress = (left: AuditionProgress, right: AuditionProgress) =>
  left.timeMs === right.timeMs &&
  left.durationMs === right.durationMs &&
  left.waiting === right.waiting &&
  left.failed === right.failed

/**
 * 一个试听播放器：所有条目共用一个 `<audio>`，同一时间只放一条。状态分两份给 `useSyncExternalStore` 订阅：
 * `getState` 只在换条、暂停、放完时变，整页列表订阅它；`getProgress` 放着时每帧都变，只让进度条、试听条订阅。
 */
export class AuditionPlayer {
  private audio: HTMLAudioElement | null = null
  private readonly listeners = new Set<() => void>()
  private state = IDLE_STATE
  private progress = IDLE_PROGRESS
  private frame = 0
  // 每次开始放记一个号：换条或暂停以后，上一次 play() 迟到的失败不再算数
  private request = 0

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.state

  getProgress = () => this.progress

  /** 没放过的从头放；是当前这条就暂停或续放。放不出来时调 `onError`。 */
  toggle(id: string, url: string, onError: () => void) {
    const audio = this.element()
    const { current, paused } = this.state
    if (current?.id === id && current.url === url) {
      if (paused) this.start(audio, onError)
      else {
        audio.pause()
        this.setState({ current, paused: true })
      }
      return
    }
    audio.setAttribute('src', url)
    this.setState({ current: { id, url }, paused: false })
    this.start(audio, onError)
  }

  /** 当前这条放不出来时重新加载再放。 */
  retry(onError: () => void) {
    if (this.audio !== null && this.state.current !== null) this.start(this.audio, onError)
  }

  /**
   * 跳到总时长的 `ratio`（0～1）处。元素还没读到有限的时长时（如没给长度的流）按 `fallbackMs` 算，
   * 也没有就不动。
   */
  seek(ratio: number, fallbackMs?: number) {
    const audio = this.audio
    if (audio === null || this.state.current === null) return
    const seconds = Number.isFinite(audio.duration)
      ? audio.duration
      : fallbackMs === undefined
        ? NaN
        : fallbackMs / 1000
    if (!Number.isFinite(seconds)) return
    audio.currentTime = Math.min(1, Math.max(0, ratio)) * seconds
    this.refresh()
  }

  /** 停下并清掉当前这条。 */
  stop() {
    this.request += 1
    cancelAnimationFrame(this.frame)
    if (this.state.current === null) return
    this.audio?.pause()
    this.setState(IDLE_STATE)
  }

  private element() {
    if (this.audio !== null) return this.audio
    const audio = new Audio()
    for (const type of MEDIA_EVENTS) audio.addEventListener(type, this.onMediaEvent)
    this.audio = audio
    return audio
  }

  private start(audio: HTMLAudioElement, onError: () => void) {
    const request = ++this.request
    // 上次放不出来的要重新加载，不然 play() 照旧失败
    if (audio.error !== null) audio.load()
    if (this.state.paused) this.setState({ current: this.state.current, paused: false })
    audio.play().catch((error: unknown) => {
      // 暂停或换条打断了还没开始的播放（AbortError），不是放不出来
      if (
        request !== this.request ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        return
      this.setState({ current: this.state.current, paused: true })
      onError()
    })
  }

  private readonly onMediaEvent = (event: Event) => {
    const { current } = this.state
    if (current !== null && (event.type === 'ended' || event.type === 'error'))
      this.setState({ current, paused: true })
    this.refresh()
    if (event.type === 'playing') this.follow()
  }

  // 放着时 timeupdate 一秒只来四次左右，进度条按帧跟着走才顺
  private follow() {
    cancelAnimationFrame(this.frame)
    const tick = () => {
      this.refresh()
      if (this.audio !== null && !this.audio.paused) this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  private refresh() {
    const next =
      this.audio === null || this.state.current === null ? IDLE_PROGRESS : progressOf(this.audio)
    if (sameProgress(next, this.progress)) return
    this.progress = next
    this.emit()
  }

  private setState(next: AuditionState) {
    this.state = next
    this.refresh()
    this.emit()
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}
