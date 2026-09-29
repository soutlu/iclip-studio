import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAYOUT, type ShellLayoutState } from './-app-shell-layout'
import { useShellLayout } from './-use-shell-layout'

const KEY = 'cue.layout.panes'
const memoryStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  }
}
const installStorage = (storage: Partial<Storage>) => vi.stubGlobal('localStorage', storage)

afterEach(() => vi.unstubAllGlobals())

describe('useShellLayout', () => {
  it.each([500, 1600])('首次打开 %s px 视口使用相同的桌面布局偏好', (viewport) => {
    installStorage(memoryStorage())
    vi.stubGlobal('innerWidth', viewport)
    expect(renderHook(() => useShellLayout()).result.current.state).toEqual(DEFAULT_LAYOUT)
  })

  it('默认保存完整偏好，重新挂载读回换位、折叠和宽度', () => {
    installStorage(memoryStorage())
    const first = renderHook(() => useShellLayout())
    act(() => {
      first.result.current.update((state) => ({
        ...state,
        firstPane: 'workbench',
        mode: 'workbench',
        activePane: 'workbench',
        sidebarWidth: 320,
      }))
    })
    expect(renderHook(() => useShellLayout()).result.current.state).toEqual(
      first.result.current.state,
    )
  })

  it.each(['chat', 'workbench'] as const)(
    '松手保留 $0 裁切和侧边栏裁切，刷新后读回实际宽度与正常宽度',
    (pane) => {
      const storage = memoryStorage()
      installStorage(storage)
      const { result } = renderHook(() => useShellLayout())
      act(() => {
        result.current.update(
          (state) => ({
            ...state,
            mode: 'split',
            sidebarWidth: 320,
            workbenchWidth: 700,
            sidebarClipWidth: 180,
            contentClip: { pane, width: 200 },
          }),
          false,
        )
        expect(storage.getItem(KEY)).toBeNull()
        result.current.persist()
      })
      expect(renderHook(() => useShellLayout()).result.current.state).toEqual(result.current.state)
      expect(result.current.state).toMatchObject({
        sidebarWidth: 320,
        workbenchWidth: 700,
        sidebarClipWidth: 180,
        contentClip: { pane, width: 200 },
      })
    },
  )

  it('拖动暂不保存，连续更新后同一事件内结束拖动保存最新值', () => {
    const storage = memoryStorage()
    installStorage(storage)
    const { result } = renderHook(() => useShellLayout())
    act(() => {
      result.current.update((state) => ({ ...state, sidebarWidth: 300 }), false)
      result.current.update((state) => ({ ...state, sidebarWidth: state.sidebarWidth + 20 }), false)
      expect(storage.getItem(KEY)).toBeNull()
      result.current.persist()
    })
    expect(result.current.state.sidebarWidth).toBe(320)
    expect(renderHook(() => useShellLayout()).result.current.state.sidebarWidth).toBe(320)
  })

  it('取消拖动恢复开始时的布局，存储仍保持拖动前偏好', () => {
    const storage = memoryStorage()
    const initial: ShellLayoutState = {
      ...DEFAULT_LAYOUT,
      mode: 'split',
      sidebarWidth: 300,
      sidebarClipWidth: 120,
      contentClip: { pane: 'chat', width: 180 },
    }
    storage.setItem(KEY, JSON.stringify(initial))
    installStorage(storage)
    const { result } = renderHook(() => useShellLayout())
    const beforeDrag = result.current.state
    act(() => {
      result.current.update(
        (state) => ({
          ...state,
          sidebarCollapsed: true,
          sidebarClipWidth: null,
          contentClip: { pane: 'workbench', width: 100 },
        }),
        false,
      )
      result.current.update(() => beforeDrag, false)
    })
    expect(result.current.state).toEqual(initial)
    expect(storage.getItem(KEY)).toBe(JSON.stringify(initial))
  })

  it('窄屏选择活动栏不覆盖已保存的宽屏模式、宽度或排列', () => {
    const storage = memoryStorage()
    const preferred: ShellLayoutState = {
      ...DEFAULT_LAYOUT,
      firstPane: 'workbench' as const,
      sidebarWidth: 350,
      workbenchWidth: 900,
      sidebarClipWidth: 100,
      contentClip: { pane: 'workbench', width: 280 },
    }
    storage.setItem(KEY, JSON.stringify(preferred))
    installStorage(storage)
    vi.stubGlobal('innerWidth', 500)
    const { result } = renderHook(() => useShellLayout())
    act(() => {
      result.current.update((state) => ({ ...state, activePane: 'workbench' }))
    })
    vi.stubGlobal('innerWidth', 1600)
    expect(renderHook(() => useShellLayout()).result.current.state).toEqual({
      ...preferred,
      activePane: 'workbench',
    })
  })

  it.each([
    '',
    '{',
    'null',
    JSON.stringify({ ...DEFAULT_LAYOUT, mode: 'none' }),
    JSON.stringify({ ...DEFAULT_LAYOUT, sidebarWidth: 401 }),
    JSON.stringify({ ...DEFAULT_LAYOUT, workbenchWidth: -1 }),
    JSON.stringify({ ...DEFAULT_LAYOUT, firstPane: null }),
    ...[56, 200, -1, '120'].map((sidebarClipWidth) =>
      JSON.stringify({ ...DEFAULT_LAYOUT, sidebarClipWidth }),
    ),
    ...[
      { pane: 'chat', width: 40 },
      { pane: 'chat', width: 400 },
      { pane: 'workbench', width: 40 },
      { pane: 'workbench', width: 560 },
      { pane: 'workbench', width: -1 },
      { pane: 'chat', width: '180' },
      { pane: 'sidebar', width: 180 },
    ].map((contentClip) => JSON.stringify({ ...DEFAULT_LAYOUT, contentClip })),
  ])('无效偏好 %s 不进入布局状态', (stored) => {
    const storage = memoryStorage()
    storage.setItem(KEY, stored)
    installStorage(storage)
    vi.stubGlobal('innerWidth', 1600)
    expect(renderHook(() => useShellLayout()).result.current.state).toEqual(DEFAULT_LAYOUT)
  })

  it('站点存储禁用时布局仍在当前会话生效', () => {
    installStorage({
      getItem: () => {
        throw new Error('站点存储已禁用')
      },
      setItem: () => {
        throw new Error('站点存储已禁用')
      },
    })
    const { result } = renderHook(() => useShellLayout())
    act(() => {
      result.current.update((state) => ({ ...state, mode: 'chat' }))
      result.current.persist()
    })
    expect(result.current.state.mode).toBe('chat')
  })
})
