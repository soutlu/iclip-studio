import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { ConversationFileOut } from '@/shared/api/generated'
import { useElementSize } from '@/shared/lib/use-element-size'
import {
  useWorkbenchRegistry,
  useWorkspaceFiles,
  WORKSPACE_FILE_SEARCH_KEY,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import { fileOwnerOf } from '../file-owner'
import { ancestorDirIds, buildFileTree } from '../file-tree'
import { FilePreview } from './file-preview'
import { FileTreeView } from './file-tree-view'
import { PanelNotice } from './panel-notice'

// 工作台至少这么宽才左树右预览并排（左栏最窄 218、间距 10、两边外边距各 12，预览还剩 300 多）；
// 再窄就是「列表 → 点进去看，返回」
const TWO_COLUMNS_MIN_WIDTH = 600

// final-cut 主文件，没选文件时默认显示它；和 storyboard/final-cut 的 PROJECT_MAIN_PATH 同值（功能模块之间不互相导入）
const FINAL_CUT_MAIN = 'final-cut/index.html'

const NO_DIRS: ReadonlySet<string> = new Set()

/** 没选文件时宽屏右边先显示哪份：final-cut 主文件，没有就按名字排第一的顶层文件，再没有就第一份。 */
const defaultFileOf = (files: readonly ConversationFileOut[]): string | undefined => {
  if (files.some((file) => file.path === FINAL_CUT_MAIN)) return FINAL_CUT_MAIN
  const paths = files.map((file) => file.path).sort((left, right) => left.localeCompare(right))
  return paths.find((path) => !path.includes('/')) ?? paths[0]
}

function FloatPanel({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel bg-surface shadow-[var(--shadow-panel),var(--shadow-specular)]"
    >
      {children}
    </section>
  )
}

/**
 * 「文件」页签：宽时左边目录树、右边预览两块浮起面板；窄时先列目录树，点进去看一份，返回再回到树。
 * 看哪份文件记在地址的 `file` 参数里，对话里的文件链接也靠它定位。
 */
export function WorkspaceFilesPanel({ conversationId, readOnly }: ArtifactRendererProps) {
  const files = useWorkspaceFiles(conversationId)
  const registry = useWorkbenchRegistry()
  const search: { [WORKSPACE_FILE_SEARCH_KEY]?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const show = (path: string | undefined) =>
    void navigate({
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        [WORKSPACE_FILE_SEARCH_KEY]: path,
      }),
      to: '.',
    })

  const [measure, size] = useElementSize<HTMLDivElement>()
  const wide = size.width >= TWO_COLUMNS_MIN_WIDTH
  const [query, setQuery] = useState('')
  // 收起的目录：平时一份；筛选时另记一份，换筛选词就清空，筛选出来的目录默认全展开
  const [collapsed, setCollapsed] = useState(NO_DIRS)
  const [filterCollapsed, setFilterCollapsed] = useState(NO_DIRS)
  const filtering = query.trim() !== ''

  const reading = search[WORKSPACE_FILE_SEARCH_KEY]
  const [lastOpened, setLastOpened] = useState<string>()
  if (reading !== undefined && reading !== lastOpened) {
    setLastOpened(reading)
    // 打开的文件所在的目录都展开，目录树里才看得到它
    const opened = new Set(ancestorDirIds(reading))
    if ([...collapsed].some((id) => opened.has(id))) {
      setCollapsed(new Set([...collapsed].filter((id) => !opened.has(id))))
    }
  }

  const list = files.data?.files
  const tree = useMemo(
    () =>
      list === undefined
        ? undefined
        : buildFileTree(list, query, (path) => fileOwnerOf(registry, path, readOnly)?.tone),
    [list, query, readOnly, registry],
  )
  const hidden = filtering ? filterCollapsed : collapsed
  const expanded = useMemo(
    () => (tree === undefined ? [] : tree.dirIds.filter((id) => !hidden.has(id))),
    [hidden, tree],
  )

  const renderTree = (selected: string | undefined, focusSelected: boolean) =>
    tree === undefined ? null : (
      <FileTreeView
        expanded={expanded}
        focusSelected={focusSelected}
        onExpandedChange={(ids) => {
          const open = new Set(ids)
          const next = new Set(tree.dirIds.filter((id) => !open.has(id)))
          if (filtering) setFilterCollapsed(next)
          else setCollapsed(next)
        }}
        onOpen={show}
        onQueryChange={(next) => {
          setQuery(next)
          setFilterCollapsed(NO_DIRS)
        }}
        query={query}
        selected={selected}
        tree={tree}
      />
    )
  const renderPreview = (path: string, onBack?: () => void) => (
    <FilePreview
      conversationId={conversationId}
      entry={list?.find((file) => file.path === path)}
      key={path}
      onBack={onBack}
      path={path}
      readOnly={readOnly}
    />
  )

  let body: ReactNode
  if (files.isPending) {
    body = (
      <FloatPanel>
        <PanelNotice text="正在读取文件…" />
      </FloatPanel>
    )
  } else if (files.isError) {
    body = (
      <FloatPanel>
        <PanelNotice text={errorMessageOf(files.error, '读取工作区文件失败，请重试')} />
      </FloatPanel>
    )
  } else if (files.data.files.length === 0) {
    body = (
      <FloatPanel>
        <PanelNotice hint="agent 写入的所有文件都将显示在此处" text="暂无文件" />
      </FloatPanel>
    )
  } else if (wide) {
    const shown = reading ?? defaultFileOf(files.data.files)
    body = (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(218px,248px)_minmax(0,1fr)] gap-2.5">
        <FloatPanel label="文件目录">{renderTree(shown, false)}</FloatPanel>
        <FloatPanel label="文件预览">
          {shown === undefined ? null : renderPreview(shown)}
        </FloatPanel>
      </div>
    )
  } else {
    body = (
      <FloatPanel label={reading === undefined ? '文件目录' : '文件预览'}>
        {reading === undefined
          ? renderTree(lastOpened, lastOpened !== undefined)
          : renderPreview(reading, () => show(undefined))}
      </FloatPanel>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3" ref={measure}>
      {body}
    </div>
  )
}
