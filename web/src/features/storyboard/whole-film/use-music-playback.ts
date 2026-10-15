/** 用 Web Audio 跟着播放头放已渲染的整条预览混音；视频元素保持静音，避免重复播放原声。
 * 起播、暂停、拖播放头、换段都跟着画面的时钟走：差出 {@link DRIFT_SECONDS} 就从播放头处重起。 */

import { useEffect, useEffectEvent, useRef } from 'react'

/** 音乐与画面的时钟差出这么多秒就从播放头处重起。正常播放时两边差在一两帧以内；换段时画面会停顿几十毫秒而音乐照走，
 * 差过这个数再对齐，免得频繁重起带出爆音。 */
const DRIFT_SECONDS = 0.12

/** 正在放的一次：从整片 `clock` 秒处起，起在上下文时间 `startedAt`。 */
type Run = { source: AudioBufferSourceNode; clock: number; startedAt: number }

type Mixer = { context: AudioContext; master: GainNode }

type Options = {
  /** 渲染好的整条混音；全部无声时没有。 */
  buffer: AudioBuffer | undefined
  /** 视频段总长：音乐放到这里为止。 */
  total: number
  playing: boolean
  muted: boolean
  /** 播放头，整片时间。 */
  clock: number
}

/** 跟着预览放音乐；返回的 `prime` 要在用户按播放的那一下同步调用：浏览器只在用户手势里放开声音（Safari 尤其严格）。 */
export function useMusicPlayback({ buffer, total, playing, muted, clock }: Options): {
  prime: () => void
} {
  const mixerRef = useRef<Mixer | null>(null)
  const runRef = useRef<Run | null>(null)

  const mixer = (): Mixer => {
    if (mixerRef.current === null) {
      const context = new AudioContext()
      const master = context.createGain()
      master.gain.setValueAtTime(muted ? 0 : 1, context.currentTime)
      master.connect(context.destination)
      mixerRef.current = { context, master }
    }
    return mixerRef.current
  }

  const stop = () => {
    const run = runRef.current
    runRef.current = null
    if (run === null) return
    run.source.stop()
    run.source.disconnect()
  }

  /** 从整片 `at` 秒处重起：起点之后的增益按曲线排好，放到视频段结尾为止。 */
  const startAt = useEffectEvent((at: number) => {
    stop()
    if (buffer === undefined || at < 0 || at >= total || at >= buffer.duration) return
    const { context, master } = mixer()
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(master)
    const now = context.currentTime
    source.start(now, at, Math.min(total, buffer.duration) - at)
    source.onended = () => {
      source.disconnect()
      if (runRef.current?.source === source) runRef.current = null
    }
    runRef.current = { source, clock: at, startedAt: now }
  })
  const stopNow = useEffectEvent(stop)
  const clockNow = useEffectEvent(() => clock)

  // 开播、停播，以及播放中换了音乐、起点、曲线或剪辑：从此刻的播放头重起。
  useEffect(() => {
    if (!playing || buffer === undefined) return undefined
    startAt(clockNow())
    return () => stopNow()
  }, [playing, buffer, total])

  // 画面停顿、跳过一截时音乐会跑偏：差多了就重起。上下文没在跑（还没得到手势）时它的时钟不走，不算跑偏。
  useEffect(() => {
    const run = runRef.current
    const context = mixerRef.current?.context
    if (!playing || context === undefined || context.state !== 'running') return
    if (run === null) {
      startAt(clock)
      return
    }
    const expected = run.clock + (context.currentTime - run.startedAt)
    if (Math.abs(expected - clock) > DRIFT_SECONDS) startAt(clock)
  }, [playing, clock])

  useEffect(() => {
    const current = mixerRef.current
    current?.master.gain.setValueAtTime(muted ? 0 : 1, current.context.currentTime)
  }, [muted])

  useEffect(
    () => () => {
      stopNow()
      mixerRef.current?.master.disconnect()
      void mixerRef.current?.context.close()
      mixerRef.current = null
    },
    [],
  )

  return {
    prime: () => {
      void mixer().context.resume()
    },
  }
}
