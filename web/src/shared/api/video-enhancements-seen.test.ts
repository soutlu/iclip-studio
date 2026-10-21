/** 看过的超分记录是模块里的状态：每个用例换一份内存存储，再按需重新载入模块。 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'cue.video-enhancements.seen'

const memoryStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  }
}

const load = async () => {
  vi.resetModules()
  return import('./video-enhancements-seen')
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() })
})

describe('看过的超分记录', () => {
  it('记了就看过，各处读到同一份；刷新之后还在', async () => {
    const { markEnhancementsSeen, useSeenEnhancements } = await load()
    const first = renderHook(() => useSeenEnhancements())
    const second = renderHook(() => useSeenEnhancements())

    act(() => markEnhancementsSeen(['a', 'b']))

    expect([...first.result.current]).toEqual(['a', 'b'])
    expect(second.result.current).toBe(first.result.current)
    const reloaded = await load()
    expect([...renderHook(() => reloaded.useSeenEnhancements()).result.current]).toEqual(['a', 'b'])
  })

  it('都看过了不写存储、不换快照', async () => {
    const setItem = vi.fn()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { ...memoryStorage(), setItem },
    })
    const { markEnhancementsSeen, useSeenEnhancements } = await load()
    act(() => markEnhancementsSeen(['a']))
    const { result } = renderHook(() => useSeenEnhancements())
    const before = result.current

    act(() => markEnhancementsSeen(['a', 'a']))

    expect(setItem).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(before)
  })

  it('超过 300 条丢最旧的', async () => {
    const { markEnhancementsSeen } = await load()
    const ids = Array.from({ length: 301 }, (_, index) => `job-${index}`)

    markEnhancementsSeen(ids.slice(0, 300))
    markEnhancementsSeen([ids[300] ?? ''])

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]
    expect(stored).toHaveLength(300)
    expect(stored[0]).toBe('job-1')
    expect(stored.at(-1)).toBe('job-300')
    const reloaded = await load()
    const seen = renderHook(() => reloaded.useSeenEnhancements()).result.current
    expect(seen.has('job-0')).toBe(false)
    expect(seen.has('job-300')).toBe(true)
  })

  it('另一个标签页记了，这里跟着变', async () => {
    const { useSeenEnhancements } = await load()
    const { result } = renderHook(() => useSeenEnhancements())
    expect(result.current.has('c')).toBe(false)

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['c']))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    })

    expect(result.current.has('c')).toBe(true)
  })

  it('站点存储读写都抛错时退回内存，照常记得住', async () => {
    const broken = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: broken, setItem: broken },
    })
    const { markEnhancementsSeen, useSeenEnhancements } = await load()
    const { result } = renderHook(() => useSeenEnhancements())
    expect(result.current.size).toBe(0)

    expect(() => act(() => markEnhancementsSeen(['d']))).not.toThrow()

    expect(result.current.has('d')).toBe(true)
  })
})
