/**
 * Markdown 富文本编辑器：进出都是 markdown 字符串，编辑时是排好版的文字（标题、加粗、斜体、无序与有序列表）。
 * 文档模型、解析与序列化用 prosemirror-markdown 的 CommonMark 一套，编辑器挂载沿用 composer 的做法：
 * 回调 ref 建 EditorView、变化中的回调走 ref，不重建实例。
 */

import { baseKeymap, setBlockType, toggleMark } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { defaultMarkdownParser, defaultMarkdownSerializer, schema } from 'prosemirror-markdown'
import { DOMSerializer, type Node as PMNode, type NodeType, Slice } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { EditorState, type Command } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import './markdown-editor.css'

const parseMarkdown = (markdown: string): PMNode =>
  defaultMarkdownParser.parse(markdown) ?? schema.node('doc', null, [schema.node('paragraph')])

const serializeMarkdown = (doc: PMNode): string => defaultMarkdownSerializer.serialize(doc)

const isEmptyDoc = (doc: PMNode) =>
  doc.childCount === 1 && doc.firstChild?.type === schema.nodes.paragraph && doc.content.size === 2

/** 选区里第一个文字块内的位置；全选（Mod-a）时选区起点落在文档根上，按钮状态要看它选到的第一段。 */
const firstTextblock = (state: EditorState) => {
  const { from, to } = state.selection
  let found: number | null = null
  state.doc.nodesBetween(
    from,
    Math.min(Math.max(to, from + 1), state.doc.content.size),
    (node, pos) => {
      if (found !== null) return false
      if (!node.isTextblock) return true
      found = Math.max(from, pos + 1)
      return false
    },
  )
  return state.doc.resolve(found ?? from)
}

/** 选区所在的最近一层列表，不在列表里为 null；`depth` 是这层列表在文档里的深度。 */
const listAround = (state: EditorState): { type: NodeType; depth: number } | null => {
  const $pos = firstTextblock(state)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const type = $pos.node(depth).type
    if (type === schema.nodes.bullet_list || type === schema.nodes.ordered_list)
      return { depth, type }
  }
  return null
}

const inHeading = (state: EditorState) => firstTextblock(state).parent.type === schema.nodes.heading

const markActive = (state: EditorState, name: 'strong' | 'em') => {
  const type = schema.marks[name]
  const { empty, from, to, $from } = state.selection
  return empty
    ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
    : state.doc.rangeHasMark(from, to, type)
}

/** 已在这种列表里就退出列表，在另一种列表里就换成这种，否则包成这种列表。 */
const toggleList =
  (listType: NodeType): Command =>
  (state, dispatch) => {
    const current = listAround(state)
    if (current === null) return wrapInList(listType)(state, dispatch)
    if (current.type === listType) return liftListItem(schema.nodes.list_item)(state, dispatch)
    dispatch?.(state.tr.setNodeMarkup(firstTextblock(state).before(current.depth), listType))
    return true
  }

const toggleHeading: Command = (state, dispatch) =>
  inHeading(state)
    ? setBlockType(schema.nodes.paragraph)(state, dispatch)
    : setBlockType(schema.nodes.heading, { level: 2 })(state, dispatch)

type FormatButton = {
  icon: IconName
  label: string
  command: Command
  active: (state: EditorState) => boolean
}

const FORMAT_BUTTONS: readonly FormatButton[] = [
  { active: inHeading, command: toggleHeading, icon: 'heading', label: '标题' },
  {
    active: (state) => markActive(state, 'strong'),
    command: toggleMark(schema.marks.strong),
    icon: 'bold',
    label: '加粗',
  },
  {
    active: (state) => markActive(state, 'em'),
    command: toggleMark(schema.marks.em),
    icon: 'italic',
    label: '斜体',
  },
  {
    active: (state) => listAround(state)?.type === schema.nodes.bullet_list,
    command: toggleList(schema.nodes.bullet_list),
    icon: 'bullet-list',
    label: '无序列表',
  },
  {
    active: (state) => listAround(state)?.type === schema.nodes.ordered_list,
    command: toggleList(schema.nodes.ordered_list),
    icon: 'ordered-list',
    label: '有序列表',
  },
]

type MarkdownEditorProps = {
  /** 当前 markdown。与编辑器上次交出的值不同（恢复版本、换了编辑对象）时整篇重载，光标回到开头。 */
  value: string
  /** 用户改了文字，交出序列化后的 markdown；没改过的文字不交，原样保留调用方的写法。 */
  onChange: (markdown: string) => void
  ariaLabel: string
  placeholder?: string
  /** 工具栏这一行左侧的内容（技能的文件页签放这里），格式按钮靠右。 */
  leading?: ReactNode
  autoFocus?: boolean
  className?: string
}

export function MarkdownEditor({
  ariaLabel,
  autoFocus = false,
  className,
  leading,
  onChange,
  placeholder,
  value,
}: MarkdownEditorProps) {
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const emittedRef = useRef(value)
  // 只在挂载时读：可访问名、占位与是否聚焦在一个编辑器的生命周期里不变。
  const mountRef = useRef({ ariaLabel, autoFocus, placeholder })
  // 工具栏的按下状态随选区与文档变；每次事务换一个新 state，React 重画按钮。
  const [editorState, setEditorState] = useState<EditorState | null>(null)

  useLayoutEffect(() => {
    onChangeRef.current = onChange
  })

  const mountEditor = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return
    const { ariaLabel: label, autoFocus: focusOnMount, placeholder: hint } = mountRef.current
    const view = new EditorView(el, {
      attributes: (state) => ({
        'aria-label': label,
        'aria-multiline': 'true',
        class: 'md-content md-editable',
        role: 'textbox',
        ...(hint === undefined ? {} : { 'data-placeholder': hint }),
        ...(isEmptyDoc(state.doc) ? { 'data-empty': '' } : {}),
      }),
      // 粘贴的纯文字按 markdown 读，从别处复制来的 markdown 原样成排版。
      clipboardTextParser: (text) => {
        const doc = parseMarkdown(text)
        return new Slice(doc.content, 1, 1)
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr)
        view.updateState(next)
        setEditorState(next)
        if (!tr.docChanged) return
        const markdown = serializeMarkdown(next.doc)
        emittedRef.current = markdown
        onChangeRef.current(markdown)
      },
      state: EditorState.create({
        doc: parseMarkdown(emittedRef.current),
        plugins: [
          history(),
          keymap({
            'Mod-b': toggleMark(schema.marks.strong),
            'Mod-i': toggleMark(schema.marks.em),
            'Mod-y': redo,
            'Mod-z': undo,
            'Shift-Mod-z': redo,
            // Tab 留给键盘移焦；列表缩进用 Mod-] / Mod-[。
            'Mod-[': liftListItem(schema.nodes.list_item),
            'Mod-]': sinkListItem(schema.nodes.list_item),
            Enter: splitListItem(schema.nodes.list_item),
          }),
          keymap(baseKeymap),
        ],
      }),
    })
    viewRef.current = view
    setEditorState(view.state)
    if (focusOnMount) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // 外部换了内容（不是自己刚交出去的那份）就整篇重载，不进撤销历史。
  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null || value === emittedRef.current) return
    emittedRef.current = value
    const state = EditorState.create({ doc: parseMarkdown(value), plugins: view.state.plugins })
    view.updateState(state)
    setEditorState(state)
  }, [value])

  const run = (command: Command) => {
    const view = viewRef.current
    if (view === null) return
    command(view.state, view.dispatch)
    view.focus()
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="-ml-1 flex shrink-0 items-center gap-3 pb-2">
        {leading === undefined ? null : <div className="min-w-0 flex-1">{leading}</div>}
        <div aria-label="文字格式" className="ml-auto flex shrink-0 gap-0.5" role="toolbar">
          {FORMAT_BUTTONS.map((button) => {
            const active = editorState !== null && button.active(editorState)
            return (
              <IconButton
                aria-pressed={active}
                className={cn(active && 'bg-state-active text-on-surface')}
                key={button.label}
                label={button.label}
                name={button.icon}
                onClick={() => run(button.command)}
                // 按下时不抢编辑器焦点，选区留着给命令用。
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
              />
            )
          })}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto text-on-surface" ref={mountEditor} />
    </div>
  )
}

/** 只读的排版预览：同一套文档模型与样式，供摘要卡片显示一段 markdown。 */
export function MarkdownPreview({ className, value }: { className?: string; value: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      parseMarkdown(value).content,
    )
    ref.current?.replaceChildren(fragment)
  }, [value])
  return <div className={cn('md-content', className)} ref={ref} />
}
