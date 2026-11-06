import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCopyFeedback } from './use-copy-feedback'

describe('useCopyFeedback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('剪贴板拒绝时不进入已复制状态', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const { result } = renderHook(() => useCopyFeedback())

    await act(() => result.current.copy('正文'))
    expect(result.current.copied).toBe(false)
  })
})
