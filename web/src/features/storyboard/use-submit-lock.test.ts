import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSubmitLock } from './use-submit-lock'

/** 外面决定什么时候结束的 task。 */
const deferred = () => {
  let resolve = (_accepted: boolean) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<boolean>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useSubmitLock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 发起一次提交，停在 sending。 */
  const start = (run: ReturnType<typeof useSubmitLock>['run']) => {
    const task = deferred()
    let running: Promise<void> = Promise.resolve()
    act(() => {
      running = run(() => task.promise)
    })
    return {
      /** task 以这个结果结束，并等 run 收尾。 */
      settle: (accepted: boolean) =>
        act(async () => {
          task.resolve(accepted)
          await running
        }),
      fail: (error: Error) => {
        act(() => task.reject(error))
        return running
      },
    }
  }

  it('sending → accepted，从受理算起恰好 1.5 秒回 idle', async () => {
    const { result } = renderHook(() => useSubmitLock())
    expect(result.current.phase).toBe('idle')

    const submission = start(result.current.run)
    expect(result.current.phase).toBe('sending')
    // 请求走多久都不算进停留。
    advance(5_000)
    expect(result.current.phase).toBe('sending')

    await submission.settle(true)
    expect(result.current.phase).toBe('accepted')
    advance(1_499)
    expect(result.current.phase).toBe('accepted')
    advance(1)
    expect(result.current.phase).toBe('idle')
  })

  it('未受理立刻回 idle，不停留', async () => {
    const { result } = renderHook(() => useSubmitLock())
    await start(result.current.run).settle(false)
    expect(result.current.phase).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('抛错立刻回 idle，错误继续往外抛', async () => {
    const { result } = renderHook(() => useSubmitLock())
    const submission = start(result.current.run)
    await act(async () => {
      await expect(submission.fail(new Error('提交失败'))).rejects.toThrow('提交失败')
    })
    expect(result.current.phase).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sending 与 accepted 里再发起都不执行，回 idle 后可以再提交', async () => {
    const { result } = renderHook(() => useSubmitLock())
    const again = vi.fn(async () => true)

    const submission = start(result.current.run)
    await act(() => result.current.run(again))
    await submission.settle(true)
    expect(result.current.phase).toBe('accepted')
    await act(() => result.current.run(again))
    expect(again).not.toHaveBeenCalled()

    advance(1_500)
    expect(result.current.phase).toBe('idle')
    await act(() => result.current.run(again))
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('提交途中卸载：task 能知道，结束后不再开始停留', async () => {
    const { result, unmount } = renderHook(() => useSubmitLock())
    const { run } = result.current
    const task = deferred()
    let mounted = () => true
    let running: Promise<void> = Promise.resolve()
    act(() => {
      running = run((isMounted) => {
        mounted = isMounted
        return task.promise
      })
    })
    expect(mounted()).toBe(true)

    unmount()
    expect(mounted()).toBe(false)
    task.resolve(true)
    await running
    expect(vi.getTimerCount()).toBe(0)
  })

  it('停留中卸载：定时器清掉', async () => {
    const { result, unmount } = renderHook(() => useSubmitLock())
    await start(result.current.run).settle(true)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
