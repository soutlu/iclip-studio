import { hotkeysCoreFeature, syncDataLoaderFeature, type Updater } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { Fragment, useEffect, useState, type CSSProperties } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { NO_HOVER_WASH_CLASS } from '@/shared/workbench'
import { formatBytes } from '../file-kind'
import { ROOT_ID, type FileTree, type TreeNode } from '../file-tree'
import { PanelNotice } from './panel-notice'
import { ToneIcon } from './tone-icon'

type FileTreeViewProps = {
  tree: FileTree
  query: string
  onQueryChange: (query: string) => void
  /** 当前展开的目录 ID 列表；内容未变时须保持引用稳定，更换数组引用会触发整树重排。 */
  expanded: string[]
  onExpandedChange: (expanded: string[]) => void
  /** 当前预览的文件路径（窄屏下为最近查看的文件）。 */
  selected: string | undefined
  /** 挂载时是否将键盘焦点定位至 `selected` 对应行（用于从预览页返回列表时恢复焦点）。 */
  focusSelected: boolean
  onOpen: (path: string) => void
}

const apply = <T,>(updater: Updater<T>, current: T): T =>
  typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater

/**
 * 工作区文件目录树：顶部为路径筛选框，下方按 WAI-ARIA Tree 模式展示目录与文件。
 * 支持方向键移动、左右键展开/收起、Home / End 跳转首尾（由 headless-tree 提供），回车或点击打开文件。
 */
export function FileTreeView({
  expanded,
  focusSelected,
  onExpandedChange,
  onOpen,
  onQueryChange,
  query,
  selected,
  tree,
}: FileTreeViewProps) {
  const [focused, setFocused] = useState<string | null>(selected ?? null)
  const nodeOf = (id: string): TreeNode => {
    const node = tree.nodes.get(id)
    if (node === undefined) throw new Error(`目录树里没有 ${id}`)
    return node
  }
  const headless = useTree<TreeNode>({
    dataLoader: {
      getChildren: (id) => {
        const node = nodeOf(id)
        return node.kind === 'dir' ? node.children : []
      },
      getItem: nodeOf,
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind === 'dir',
    onPrimaryAction: (item) => {
      const node = item.getItemData()
      if (node.kind === 'file') onOpen(node.id)
    },
    rootItemId: ROOT_ID,
    setExpandedItems: (updater) => onExpandedChange(apply(updater, [...expanded])),
    setFocusedItem: (updater) => setFocused((current) => apply(updater, current)),
    state: {
      expandedItems: expanded,
      focusedItem: focused !== null && tree.nodes.has(focused) ? focused : null,
    },
  })

  useEffect(() => headless.rebuildTree(), [headless, tree])

  useEffect(() => {
    if (focusSelected) headless.updateDomFocus()
  }, [focusSelected, headless])

  const count = tree.filePaths.length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2.5 pt-2.5 pb-2">
        <label className="flex h-7.75 items-center gap-1.5 rounded-control bg-surface-container-low px-2 text-on-surface-faint shadow-[var(--shadow-control-well),inset_0_0_0_1px_var(--color-panel-line)] focus-within:shadow-[var(--shadow-control-well),inset_0_0_0_1px_var(--color-on-surface-variant)]">
          <Icon decorative name="search" size="xs" />
          <input
            aria-label="筛选文件"
            className="field-nested-input min-w-0 flex-1 bg-transparent text-label text-on-surface placeholder:text-on-surface-faint"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="筛选文件…"
            type="text"
            value={query}
          />
          <span className="shrink-0 font-mono text-caption">{count}</span>
        </label>
      </div>
      {count === 0 ? (
        <PanelNotice text="暂无匹配的文件" />
      ) : (
        <div
          {...headless.getContainerProps('文件目录')}
          className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-y-auto px-2 pt-0.5 pb-3"
        >
          {headless.getItems().map((item) => {
            const node = item.getItemData()
            const depth = { '--tree-depth': item.getItemMeta().level } as CSSProperties
            const current = node.kind === 'file' && node.id === selected
            return (
              <Fragment key={item.getKey()}>
                {node.afterDirs ? (
                  <div aria-hidden className="mx-2 my-1 h-px shrink-0 bg-panel-line" />
                ) : null}
                <div className="files-tree-row shrink-0" style={depth}>
                  <button
                    {...item.getProps()}
                    aria-selected={current}
                    role="treeitem"
                    className={cn(
                      'flex w-full ui-state cursor-pointer items-center rounded-sm text-left text-label ui-focus',
                      node.kind === 'dir'
                        ? 'h-7.5 gap-1.5 px-1.5 font-semibold text-on-surface-variant hover:text-on-surface'
                        : 'h-7.75 gap-1.5 px-2 text-on-surface-variant hover:text-on-surface',
                      current && [
                        'bg-card font-semibold text-on-surface shadow-[var(--shadow-pill),var(--shadow-specular)]',
                        NO_HOVER_WASH_CLASS,
                      ],
                    )}
                    type="button"
                  >
                    {node.kind === 'dir' ? (
                      <Icon
                        className={cn(
                          'shrink-0 text-on-surface-faint transition-transform ui-motion-s',
                          !item.isExpanded() && '-rotate-90',
                        )}
                        decorative
                        name="final-cut-expand"
                        size="xs"
                      />
                    ) : null}
                    <ToneIcon name={node.icon} tone={node.tone} />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {node.kind === 'file' ? (
                      <span className="shrink-0 font-mono text-caption font-normal text-on-surface-faint">
                        {formatBytes(node.file.sizeBytes)}
                      </span>
                    ) : null}
                  </button>
                </div>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
