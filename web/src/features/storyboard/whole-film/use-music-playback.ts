import { useEffect, useEffectEvent, useRef } from 'react'

const DRIFT_SECONDS = 0.12

type Run = { source: AudioBufferSourceNode; clock: number; startedAt: number }

type Mixer = { context: AudioContext; master: GainNode }

type Options = {
  buffer: AudioBuffer | undefined
  duration: number
  playing: boolean
  muted: boolean
  clock: number
}

// 浏览器只在用户手势里放开 AudioContext 的声音（Safari 尤其严格），`prime` 要在按播放的那一下同步调用。
export function useMusicPlayback({ buffer, duration, playing, muted, clock }: Options): {
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

  const startAt = useEffectEvent((at: number) => {
    stop()
    if (buffer === undefined || at < 0 || at >= duration || at >= buffer.duration) return
    const { context, master } = mixer()
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(master)
    const now = context.currentTime
    source.start(now, at, Math.min(duration, buffer.duration) - at)
    source.onended = () => {
      source.disconnect()
      if (runRef.current?.source === source) runRef.current = null
    }
    runRef.current = { source, clock: at, startedAt: now }
  })
  const stopNow = useEffectEvent(stop)
  const clockNow = useEffectEvent(() => clock)

  useEffect(() => {
    if (!playing || buffer === undefined) return undefined
    startAt(clockNow())
    return () => stopNow()
  }, [playing, buffer, duration])

  useEffect(() => {
    const run = runRef.current
    const context = mixerRef.current?.context
    // 没得到用户手势的 AudioContext 不在 running 状态，它的时钟不走，不能拿来比漂移。
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
