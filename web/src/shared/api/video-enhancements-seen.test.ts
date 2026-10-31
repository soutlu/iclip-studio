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
  it('记了就看过；刷新之后还在', async () => {
    const { markEnhancementsSeen, useSeenEnhancements } = await load()
    const first = renderHook(() => useSeenEnhancements())

    act(() => markEnhancementsSeen(['a', 'b']))

    expect([...first.result.current]).toEqual(['a', 'b'])
    const reloaded = await load()
    expect([...renderHook(() => reloaded.useSeenEnhancements()).result.current]).toEqual(['a', 'b'])
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
