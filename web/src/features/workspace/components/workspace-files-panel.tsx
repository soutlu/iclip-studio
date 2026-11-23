import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { ConversationFileOut } from '@/shared/api/generated'
import { useElementSize } from '@/shared/lib/use-element-size'
import {
  composeArtifacts,
  useWorkbenchRegistry,
  useWorkspaceFiles,
  WORKSPACE_FILE_SEARCH_KEY,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import { documentToneOf, fileOwnerOf } from '../file-owner'
import { ancestorDirIds, buildFileTree } from '../file-tree'
import { FilePreview } from './file-preview'
import { FileTreeView } from './file-tree-view'
import { PanelNotice } from './panel-notice'

// 切换为「左树右预览」双栏布局的最小工作台宽度（左栏最小 218px、栏间距 10px、左右外边距各 12px，预览区留余 340px 以上）；
// 低于此阈值时退化为单栏「列表 → 预览」切换视图。
const TWO_COLUMNS_MIN_WIDTH = 600

// final-cut 工程主文件路径，未选中文件时默认预览；与 storyboard/final-cut 的 PROJECT_MAIN_PATH 保持一致（跨 feature 模块不直接互相导入）
const FINAL_CUT_MAIN = 'final-cut/index.html'

const NO_DIRS: ReadonlySet<string> = new Set()

/** 计算宽屏未指定文件时的默认预览项：优先 final-cut 主文件，其次按名称排序的首个顶层文件，否则取首份文件。 */
const defaultFileOf = (files: readonly ConversationFileOut[]): string | undefined => {
  if (files.some((file) => file.path === FINAL_CUT_MAIN)) return FINAL_CUT_MAIN
  const paths = files.map((file) => file.path).sort((left, right) => left.localeCompare(right))
  return paths.find((path) => !path.includes('/')) ?? paths[0]
}

function FloatPanel({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-panel bg-surface shadow-[var(--shadow-panel),var(--shadow-specular)]"
    >
      {children}
    </section>
  )
}

/**
 * 「文件」页签：宽屏下分左右两块浮起面板展示目录树与文件预览；窄屏下在目录树与预览视图间切换。
 * 当前查看的文件路径记录在 URL 的 `file` 查询参数中，对话消息内的文件链接亦通过该参数定位。
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
  // 目录收起状态分两份维护：常规态独立保存；筛选态在关键词变化时重置为空，确保命中目录默认展开
  const [collapsed, setCollapsed] = useState(NO_DIRS)
  const [filterCollapsed, setFilterCollapsed] = useState(NO_DIRS)
  const filtering = query.trim() !== ''

  const reading = search[WORKSPACE_FILE_SEARCH_KEY]
  const [lastOpened, setLastOpened] = useState<string>()
  if (reading !== undefined && reading !== lastOpened) {
    setLastOpened(reading)
    // 自动展开所打开文件的所有祖先目录，确保该节点在目录树中可见
    const opened = new Set(ancestorDirIds(reading))
    if ([...collapsed].some((id) => opened.has(id))) {
      setCollapsed(new Set([...collapsed].filter((id) => !opened.has(id))))
    }
  }

  const list = files.data?.files
  // 当前工作台已存在的产物页签 ID 集合（工具帧产物不关联工作区文件，无需传入）
  const tabs = useMemo(
    () =>
      new Set(composeArtifacts(registry, list ?? [], [], readOnly).map((artifact) => artifact.id)),
    [list, readOnly, registry],
  )
  const tree = useMemo(
    () =>
      list === undefined
        ? undefined
        : buildFileTree(list, query, (path) => documentToneOf(fileOwnerOf(registry, path, tabs))),
    [list, query, registry, tabs],
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
      owner={fileOwnerOf(registry, path, tabs)}
      path={path}
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
        <PanelNotice hint="Agent 写入的所有文件都将显示在此处" text="暂无文件" />
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
