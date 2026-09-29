import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  resizeContent,
  resizeSidebar,
  resolveShellLayout,
  selectContentPane,
  type ShellLayoutState,
} from './-app-shell-layout'

const SPLIT_LAYOUT: ShellLayoutState = { ...DEFAULT_LAYOUT, mode: 'split' }

const layoutAt = (viewport: number, changes: Partial<ShellLayoutState> = {}, hasWorkbench = true) =>
  resolveShellLayout({ viewport, hasWorkbench, state: { ...SPLIT_LAYOUT, ...changes } })

describe('内容栏切换', () => {
  it.each([
    { pane: 'chat', mode: 'split' },
    { pane: 'workbench', mode: 'split' },
    { pane: 'chat', mode: 'chat' },
    { pane: 'workbench', mode: 'workbench' },
  ] as const)('窄屏切换到 $pane 不覆盖桌面裁切和排列', ({ pane, mode }) => {
    const state: ShellLayoutState = {
      ...SPLIT_LAYOUT,
      contentClip: { pane: 'chat', width: 250 },
      firstPane: 'workbench',
      workbenchWidth: 720,
    }
    const selected = selectContentPane(state, pane, mode, false)
    expect(selected).toEqual({ ...state, activePane: pane })
    expect(
      resolveShellLayout({ viewport: 1600, hasWorkbench: true, state: selected }).chatWidth,
    ).toBe(250)
  })

  it('窄屏显式切换不初始化桌面模式', () => {
    expect(selectContentPane(DEFAULT_LAYOUT, 'workbench', 'split', false)).toEqual({
      ...DEFAULT_LAYOUT,
      activePane: 'workbench',
    })
  })

  it.each(['split', 'chat', 'workbench'] as const)('桌面选择 $0 清除裁切并保留正常宽度', (mode) => {
    const state: ShellLayoutState = {
      ...SPLIT_LAYOUT,
      contentClip: { pane: 'workbench', width: 250 },
      workbenchWidth: 720,
    }
    expect(selectContentPane(state, 'workbench', mode, true)).toEqual({
      ...state,
      activePane: 'workbench',
      contentClip: null,
      mode,
    })
  })
})

describe('应用壳列宽', () => {
  it.each([
    { viewport: 1600, state: {} },
    { viewport: 1335, state: {} },
    { viewport: 1000, state: { sidebarCollapsed: true } },
    { viewport: 500, state: {} },
  ])('视口 $viewport 的内容始终填满剩余空间', ({ viewport, state }) => {
    const layout = layoutAt(viewport, state)
    expect(layout.chatWidth + layout.workbenchWidth).toBe(layout.contentWidth)
    expect(layout.contentWidth + (layout.compact ? 0 : layout.sidebarWidth)).toBe(viewport)
  })

  it('展开宽度受侧边栏上限和两栏最小宽约束，热区不占布局', () => {
    expect(layoutAt(1600, { sidebarWidth: 500, workbenchWidth: 900 })).toMatchObject({
      sidebarWidth: 400,
      contentWidth: 1200,
      workbenchWidth: 800,
      chatWidth: 400,
      workbenchMax: 800,
    })
    expect(layoutAt(1600, { sidebarWidth: 100, workbenchWidth: 300 })).toMatchObject({
      sidebarWidth: 200,
      workbenchWidth: 560,
    })
  })

  it.each([
    { viewport: 1223, collapsed: false, sideBySide: false },
    { viewport: 1224, collapsed: false, sideBySide: true },
    { viewport: 1015, collapsed: true, sideBySide: false },
    { viewport: 1016, collapsed: true, sideBySide: true },
  ])('视口 $viewport 侧边栏折叠 $collapsed 的并排能力为 $sideBySide', (input) => {
    expect(layoutAt(input.viewport, { sidebarCollapsed: input.collapsed }).sideBySide).toBe(
      input.sideBySide,
    )
  })

  it.each([
    { mode: 'split', activePane: 'chat' },
    { mode: 'split', activePane: 'workbench' },
    { mode: 'chat', activePane: 'workbench' },
    { mode: 'workbench', activePane: 'chat' },
  ] as const)('空间不足时跟随活动栏 $activePane，扩大后恢复 $mode 偏好', ({ mode, activePane }) => {
    const state = { ...SPLIT_LAYOUT, mode, activePane }
    const narrow = resolveShellLayout({ viewport: 1000, hasWorkbench: true, state })
    const wide = resolveShellLayout({ viewport: 1600, hasWorkbench: true, state })
    expect(narrow.mode).toBe(activePane)
    expect(wide.mode).toBe(mode)
    expect(state.workbenchWidth).toBe(820)
  })

  it('单栏占满余量，工作台可超出两栏模式的最大宽', () => {
    expect(layoutAt(1600, { mode: 'workbench' })).toMatchObject({
      sideBySide: true,
      mode: 'workbench',
      chatWidth: 40,
      workbenchWidth: 1296,
      workbenchMax: 936,
    })
    expect(layoutAt(1600, { mode: 'chat' })).toMatchObject({
      chatWidth: 1296,
      workbenchWidth: 40,
    })
  })

  it('无工作台路由完整显示主区，不受上次折叠和换位影响', () => {
    expect(layoutAt(1600, { mode: 'workbench', firstPane: 'workbench' }, false)).toMatchObject({
      mode: 'chat',
      sideBySide: false,
      chatWidth: 1336,
      workbenchWidth: 0,
    })
  })

  it('紧凑屏侧边栏不占位且隐藏的内容栏不留图标栏，600px 恢复桌面图标栏', () => {
    expect(layoutAt(599, { mode: 'workbench', activePane: 'workbench' })).toMatchObject({
      compact: true,
      sidebarWidth: 264,
      contentWidth: 599,
      chatWidth: 0,
      workbenchWidth: 599,
    })
    expect(
      layoutAt(600, { sidebarCollapsed: true, mode: 'workbench', activePane: 'workbench' }),
    ).toMatchObject({
      compact: false,
      sidebarWidth: 56,
      contentWidth: 544,
      chatWidth: 40,
      workbenchWidth: 504,
    })
  })
})

describe('连续拖动与内容裁切', () => {
  it('侧边栏宽度连续经过裁切区，到 56px 才折叠，反向拖动连续恢复', () => {
    let state = { ...SPLIT_LAYOUT, sidebarWidth: 320 }
    for (const width of [200, 199, 152, 128, 57, 56, 57, 128, 152, 199, 200, 320]) {
      state = resizeSidebar(state, width)
      expect(resolveShellLayout({ viewport: 1600, hasWorkbench: true, state }).sidebarWidth).toBe(
        width,
      )
      expect(state.sidebarCollapsed).toBe(width === 56)
      expect(state.sidebarClipWidth).toBe(width > 56 && width < 200 ? width : null)
    }
    expect(resizeSidebar(state, -20)).toMatchObject({
      sidebarCollapsed: true,
      sidebarClipWidth: null,
    })
    expect(resizeSidebar(state, 900)).toMatchObject({ sidebarWidth: 400, sidebarClipWidth: null })
  })

  it('裁切与折叠保留侧边栏的正常宽度，越过阈值恢复常规调宽', () => {
    const clipped = resizeSidebar({ ...SPLIT_LAYOUT, sidebarWidth: 320 }, 120)
    expect(clipped).toMatchObject({ sidebarWidth: 320, sidebarClipWidth: 120 })
    const collapsed = resizeSidebar(clipped, 56)
    expect(collapsed).toMatchObject({ sidebarWidth: 320, sidebarClipWidth: null })
    expect(resizeSidebar(collapsed, 201)).toMatchObject({
      sidebarWidth: 201,
      sidebarClipWidth: null,
      sidebarCollapsed: false,
    })
  })

  it.each(['chat', 'workbench'] as const)(
    '工作台在 $0 排列下逐像素经过阈值和图标栏，反向也不跳变',
    (firstPane) => {
      let state = { ...SPLIT_LAYOUT, firstPane, workbenchWidth: 700 }
      for (const width of [560, 559, 320, 280, 41, 40, 41, 280, 320, 559, 560, 700]) {
        state = resizeContent(state, width, 1200)
        const geometry = resolveShellLayout({ viewport: 1464, hasWorkbench: true, state })
        expect(geometry.workbenchWidth).toBe(width)
        expect(geometry.chatWidth).toBe(1200 - width)
        expect(state.mode).toBe(width === 40 ? 'chat' : 'split')
        expect(state.contentClip).toEqual(
          width > 40 && width < 560 ? { pane: 'workbench', width } : null,
        )
      }
    },
  )

  it.each(['chat', 'workbench'] as const)(
    '对话在 $0 排列下逐像素经过阈值和图标栏，反向也不跳变',
    (firstPane) => {
      let state = { ...SPLIT_LAYOUT, firstPane, workbenchWidth: 700 }
      for (const width of [400, 399, 240, 200, 41, 40, 41, 200, 240, 399, 400, 500]) {
        state = resizeContent(state, 1200 - width, 1200)
        const geometry = resolveShellLayout({ viewport: 1464, hasWorkbench: true, state })
        expect(geometry.chatWidth).toBe(width)
        expect(geometry.workbenchWidth).toBe(1200 - width)
        expect(state.mode).toBe(width === 40 ? 'workbench' : 'split')
        expect(state.contentClip).toEqual(
          width > 40 && width < 400 ? { pane: 'chat', width } : null,
        )
      }
    },
  )

  it('快速跨过两端时替换裁切对象，正常区与图标栏清除裁切，保留有用展开宽度', () => {
    const original = { ...SPLIT_LAYOUT, workbenchWidth: 700 }
    const workbenchClip = resizeContent(original, 150, 1200)
    expect(workbenchClip).toMatchObject({
      contentClip: { pane: 'workbench', width: 150 },
      workbenchWidth: 700,
    })
    const chatClip = resizeContent(workbenchClip, 1050, 1200)
    expect(chatClip).toMatchObject({
      contentClip: { pane: 'chat', width: 150 },
      workbenchWidth: 700,
    })
    expect(resizeContent(chatClip, 750, 1200)).toMatchObject({
      contentClip: null,
      workbenchWidth: 750,
    })
    expect(resizeContent(chatClip, 1300, 1200)).toMatchObject({
      contentClip: null,
      mode: 'workbench',
      activePane: 'workbench',
      workbenchWidth: 700,
    })
    expect(resizeContent(chatClip, -100, 1200)).toMatchObject({
      contentClip: null,
      mode: 'chat',
      activePane: 'chat',
      workbenchWidth: 700,
    })
  })

  it.each([0, 400, 800])('不足并排宽度时拖到 %s 不覆盖宽屏裁切与展开偏好', (width) => {
    const state: ShellLayoutState = {
      ...SPLIT_LAYOUT,
      activePane: 'workbench',
      contentClip: { pane: 'chat', width: 180 },
    }
    expect(resizeContent(state, width, 800)).toEqual(state)
  })

  it.each(['chat', 'workbench'] as const)(
    '窗口缩小暂时隐藏 $0 裁切，恢复宽屏后保持原来的裁切与展开偏好',
    (pane) => {
      const state: ShellLayoutState = {
        ...SPLIT_LAYOUT,
        sidebarWidth: 320,
        sidebarClipWidth: 120,
        workbenchWidth: 700,
        contentClip: { pane, width: 180 },
        firstPane: 'workbench',
        activePane: 'workbench',
      }
      const original = structuredClone(state)
      const wide = resolveShellLayout({ viewport: 1600, hasWorkbench: true, state })
      const narrow = resolveShellLayout({ viewport: 900, hasWorkbench: true, state })
      const compact = resolveShellLayout({ viewport: 500, hasWorkbench: true, state })
      expect(wide.sidebarWidth).toBe(120)
      expect(pane === 'chat' ? wide.chatWidth : wide.workbenchWidth).toBe(180)
      expect(narrow).toMatchObject({ mode: 'workbench', chatWidth: 40, workbenchWidth: 740 })
      expect(compact).toMatchObject({ sidebarWidth: 320, chatWidth: 0, workbenchWidth: 500 })
      expect(resolveShellLayout({ viewport: 1600, hasWorkbench: true, state })).toEqual(wide)
      expect(state).toEqual(original)
    },
  )
})

describe('键盘边界调宽', () => {
  it('侧边栏从图标栏一步恢复保存宽度，反方向保持折叠', () => {
    const state = { ...SPLIT_LAYOUT, sidebarCollapsed: true, sidebarWidth: 320 }
    expect(resizeSidebar(state, 72, 'keyboard')).toMatchObject({
      sidebarCollapsed: false,
      sidebarWidth: 320,
      sidebarClipWidth: null,
    })
    expect(resizeSidebar(state, 40, 'keyboard')).toEqual(state)
  })

  it('侧边栏达到内容阈值后继续按键进入裁切，到图标栏才折叠', () => {
    const minimum = { ...SPLIT_LAYOUT, sidebarWidth: 200 }
    const clipped = resizeSidebar(minimum, 184, 'keyboard')
    expect(clipped).toMatchObject({
      sidebarCollapsed: false,
      sidebarWidth: 200,
      sidebarClipWidth: 184,
    })
    const collapsed = resizeSidebar(clipped, 56, 'keyboard')
    expect(collapsed).toMatchObject({
      sidebarCollapsed: true,
      sidebarWidth: 200,
      sidebarClipWidth: null,
    })
    expect(resizeSidebar(collapsed, 72, 'keyboard')).toEqual(minimum)
  })

  it.each([
    { mode: 'chat', width: 56, expands: true },
    { mode: 'chat', width: 24, expands: false },
    { mode: 'workbench', width: 1144, expands: true },
    { mode: 'workbench', width: 1176, expands: false },
    { mode: null, width: 56, expands: true },
  ] as const)('$mode 模式调到 $width 时展开为 $expands', ({ mode, width, expands }) => {
    const state = { ...SPLIT_LAYOUT, mode, workbenchWidth: 720 }
    expect(resizeContent(state, width, 1200, 'keyboard')).toEqual({
      ...state,
      mode: expands ? 'split' : mode,
    })
  })

  it.each([
    {
      pane: 'workbench',
      width: 560,
      next: 544,
      clip: 544,
      rail: 40,
      collapsed: 'chat',
      restore: 56,
    },
    {
      pane: 'chat',
      width: 800,
      next: 816,
      clip: 384,
      rail: 1160,
      collapsed: 'workbench',
      restore: 1144,
    },
  ] as const)(
    '$pane 内容阈值后按键继续裁切，到图标栏折叠，再反向一步恢复',
    ({ pane, width, next, clip, rail, collapsed, restore }) => {
      const state = { ...SPLIT_LAYOUT, workbenchWidth: width }
      const clipped = resizeContent(state, next, 1200, 'keyboard')
      expect(clipped).toMatchObject({
        mode: 'split',
        contentClip: { pane, width: clip },
        workbenchWidth: width,
      })
      const closed = resizeContent(clipped, rail, 1200, 'keyboard')
      expect(closed).toMatchObject({
        mode: collapsed,
        activePane: collapsed,
        contentClip: null,
        workbenchWidth: width,
      })
      expect(resizeContent(closed, restore, 1200, 'keyboard')).toMatchObject({
        mode: 'split',
        contentClip: null,
        workbenchWidth: width,
      })
    },
  )
})
