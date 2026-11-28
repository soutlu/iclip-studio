import { useLayoutEffect, useRef, useState } from 'react'
import type { FilmClip } from './composition/film'
import { CATALOG_TABS, type CatalogTab, type SideTab } from './side-tabs'
import { useEditorLayout } from './use-editor-layout'

/**
 * 选中的片段和跟着选中走的右栏：选中哪些片段、右栏停在哪个页签、右栏宽度与收起态、时间线高度。
 * `clips` 是时间线上的片段，`root` 是编辑器根节点，`stage` 是舞台元素（布局按它量）。
 */
export function useSideSelection(
  clips: readonly FilmClip[],
  root: HTMLElement | null,
  stage: HTMLDivElement | null,
) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // 选中的片段被撤销或删掉以后就不算选中了
  const selectedClips = clips.filter((clip) => selectedIds.has(clip.id))
  const selected = new Set(selectedClips.map((clip) => clip.id))
  const clearSelection = () => setSelectedIds(new Set())
  // 侧栏：选中从没有变成有、或换了别的片段时切到「属性」，选中没了回到切走之前停的目录页签。
  // 按实际还选中着的片段算，撤销、删除让选中的片段不存在了也算取消选中
  const [sideTab, setSideTab] = useState<SideTab>('shots')
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('shots')
  const selectionKey = [...selected].sort().join(' ')
  const [seenSelection, setSeenSelection] = useState(selectionKey)
  // 停留在「字幕」页签时点选片段不自动切走，对应字幕直接在列表中高亮标注
  if (selectionKey !== seenSelection) {
    setSeenSelection(selectionKey)
    if (sideTab !== 'captions') setSideTab(selectionKey === '' ? catalogTab : 'props')
  }
  const selectOnly = (id: string) => setSelectedIds(new Set([id]))
  const sideRef = useRef<HTMLElement | null>(null)
  // 右栏页签内容的可见区域：选音浮层左右与它的内容边线对齐
  const [sideScroll, setSideScroll] = useState<HTMLDivElement | null>(null)
  const timelinePanelRef = useRef<HTMLDivElement | null>(null)
  // 右栏宽度、收起态与时间线高度。选中片段时若右栏已收起则保持收起（仅点亮「属性」圆点），点击页签或双击片段时展开
  const { layout, setSideCollapsed, sideSplitter, timelineSplitter } = useEditorLayout(() => ({
    stage,
    side: sideRef.current,
    timeline: timelinePanelRef.current,
  }))
  const openSideTab = (value: string) => {
    setSideCollapsed(false)
    if (value === 'props') {
      setSideTab('props')
      return
    }
    const tab = CATALOG_TABS.find((each) => each === value)
    if (tab === undefined) return
    setCatalogTab(tab)
    setSideTab(tab)
  }
  // 切到「属性」时焦点可能还在刚藏起来的目录里（比如在卡片上按了 ]），浏览器随后把它丢到页面上，
  // 快捷键就收不到了：交还给编辑器的根节点
  useLayoutEffect(() => {
    const focused = document.activeElement
    if (focused === null || sideRef.current?.contains(focused) !== true) return
    if (focused.closest('[role="tabpanel"][hidden]') !== null) root?.focus()
  }, [root, sideTab])

  /**
   * 切至「属性」或收起右栏时，保留切离前所在目录页签的挂载状态（仅隐藏展示），返回时保留搜索词、筛选条件与滚动位置；
   * 右栏收起时「属性」页签同样仅隐藏而不卸载。
   */
  const catalogPanel = (tab: CatalogTab) =>
    tab === catalogTab
      ? { forceMount: true as const, hidden: sideTab !== tab || layout.sideCollapsed }
      : {}

  return {
    setSelectedIds,
    selectedClips,
    selected,
    clearSelection,
    sideTab,
    selectOnly,
    sideRef,
    sideScroll,
    setSideScroll,
    timelinePanelRef,
    layout,
    setSideCollapsed,
    sideSplitter,
    timelineSplitter,
    openSideTab,
    catalogPanel,
  }
}
