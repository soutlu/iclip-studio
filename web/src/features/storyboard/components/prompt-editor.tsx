/** 帧记号使用 inline atom NodeView；只读与编辑共用实例，通过 editable 切换。可编辑时敲 `@` 弹出本组图片（见 `useFrameMention`）。 */

import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Slice, type Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import type { PromptInsertion } from '../shot-document'
import { FrameMentionMenu } from './frame-mention-menu'
import { docToPrompt, promptOffsetAt, promptToDoc } from './prompt-editor-doc'
import { useFrameMention, type FrameMentionOptions } from './use-frame-mention'

/** NodeView 经 ref 读取最新数据，避免重建编辑器。 */
type ChipContext = {
  frameUrl: (n: number) => string | undefined
  highlighted: () => number | undefined
  onPick: (n: number) => void
}

// 帧芯片的外观、舞台高亮与聚焦环都在 storyboard.css 的「帧芯片」一节；这里只给结构与状态。
const CHIP_CLASS = 'frame-chip cursor-pointer select-none'

const isActivationKey = (key: string) => key === 'Enter' || key === ' '

class FrameChipView implements NodeView {
  readonly dom: HTMLSpanElement
  private readonly img: HTMLImageElement
  private readonly n: number
  private readonly ctx: ChipContext
  private readonly chips: Set<FrameChipView>

  constructor(node: PMNode, ctx: ChipContext, chips: Set<FrameChipView>) {
    this.ctx = ctx
    this.chips = chips
    this.n = node.attrs['n'] as number
    this.dom = document.createElement('span')
    this.dom.dataset['n'] = String(this.n)
    this.dom.dataset['token'] = node.attrs['token'] as string
    this.dom.setAttribute('role', 'button')
    this.dom.setAttribute('aria-label', `看第 ${this.n} 帧`)
    this.dom.contentEditable = 'false'
    this.dom.tabIndex = 0
    this.dom.className = CHIP_CLASS
    // 外层是普通行内元素，胶囊画在里层：外层尾部的零宽连字符让芯片和紧跟的标点不在中间断行。
    const pill = document.createElement('span')
    pill.className = 'frame-chip-pill ui-motion-s'
    this.img = document.createElement('img')
    this.img.alt = ''
    const label = document.createElement('span')
    label.textContent = `@${this.n}`
    pill.append(this.img, label)
    this.dom.append(pill)
    this.dom.addEventListener('click', (event) => {
      event.preventDefault()
      this.ctx.onPick(this.n)
    })
    this.dom.addEventListener('keydown', (event) => {
      if (!isActivationKey(event.key)) return
      event.preventDefault()
      this.ctx.onPick(this.n)
    })
    chips.add(this)
    this.refresh()
  }

  refresh() {
    const url = this.ctx.frameUrl(this.n)
    if (url === undefined) this.img.removeAttribute('src')
    else if (this.img.getAttribute('src') !== url) this.img.src = url
    this.img.hidden = url === undefined
    // 舞台正在看的那一帧实色高亮。
    this.dom.toggleAttribute('data-highlighted', this.ctx.highlighted() === this.n)
  }

  stopEvent(event: Event) {
    return (
      event.type === 'click' ||
      event.type === 'mousedown' ||
      (event.type === 'keydown' && event instanceof KeyboardEvent && isActivationKey(event.key))
    )
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.chips.delete(this)
  }
}

export type PromptEditorHandle = { getInsertion: () => PromptInsertion | undefined }

type PromptEditorProps = {
  value: string
  ref?: Ref<PromptEditorHandle> | undefined
  /** 帧数组下标为编号减一。 */
  frames: readonly string[]
  /** 分镜画幅；帧缩略图加载前按它占位。 */
  aspectRatio: string
  highlighted?: number | undefined
  readOnly?: boolean
  onChange?: ((value: string) => void) | undefined
  onPickFrame?: ((n: number) => void) | undefined
  /** 敲 `@` 选图；不给时 `@` 就是普通字符。 */
  mention?: FrameMentionOptions | undefined
  'aria-label': string
  className?: string
}

export function PromptEditor({
  'aria-label': ariaLabel,
  aspectRatio,
  className,
  frames,
  highlighted,
  mention,
  value,
  ref,
  onChange,
  onPickFrame,
  readOnly = false,
}: PromptEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const hadSelectionRef = useRef(false)
  const chipsRef = useRef(new Set<FrameChipView>())
  const ratio = aspectValueOf(aspectRatio)
  const frameMention = useFrameMention(viewRef, mention, frames.length)
  // 编辑器只建一次；变化中的回调与数据经 ref 读最新值
  const latestRef = useRef({ frames, highlighted, onChange, onPickFrame, readOnly })
  useEffect(() => {
    latestRef.current = { frames, highlighted, onChange, onPickFrame, readOnly }
  })
  // 记录最近序列化结果，忽略编辑器自身发出的更新，避免重置光标。
  const serializedRef = useRef(value)
  const initialRef = useRef({ ariaLabel, createMentionPlugin: frameMention.createPlugin, value })
  useImperativeHandle(
    ref,
    () => ({
      getInsertion: () => {
        const view = viewRef.current
        if (view === null || !hadSelectionRef.current) return undefined
        const { doc, selection } = view.state
        return {
          text: docToPrompt(doc),
          start: promptOffsetAt(doc, selection.from),
          end: promptOffsetAt(doc, selection.to),
        }
      },
    }),
    [],
  )

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const chips = chipsRef.current
    const ctx: ChipContext = {
      frameUrl: (n) => latestRef.current.frames[n - 1],
      highlighted: () => latestRef.current.highlighted,
      onPick: (n) => latestRef.current.onPickFrame?.(n),
    }
    const view: EditorView = new EditorView(host, {
      // 只读时 contenteditable 关掉就不可聚焦了；给个 tabindex，键盘和点击仍能落到这段上。
      attributes: () => ({
        'aria-label': initialRef.current.ariaLabel,
        'aria-multiline': 'true',
        class: 'prompt-editor-content',
        role: 'textbox',
        ...(latestRef.current.readOnly ? { 'aria-readonly': 'true', tabindex: '0' } : {}),
      }),
      dispatchTransaction(tr) {
        const next = view.state.apply(tr)
        view.updateState(next)
        if (!tr.docChanged) return
        const changed = docToPrompt(next.doc)
        serializedRef.current = changed
        latestRef.current.onChange?.(changed)
      },
      clipboardTextParser: (text) => new Slice(promptToDoc(text).content, 1, 1),
      handleDOMEvents: {
        focus: () => {
          hadSelectionRef.current = true
          return false
        },
      },
      editable: () => !latestRef.current.readOnly,
      nodeViews: { frame: (node) => new FrameChipView(node, ctx, chips) },
      state: EditorState.create({
        doc: promptToDoc(initialRef.current.value),
        // 选图排在 keymap 之前：打开时的 Enter 与方向键先归它，不分段、不挪光标。
        plugins: [
          initialRef.current.createMentionPlugin(),
          history(),
          keymap({ 'Mod-y': redo, 'Mod-z': undo, 'Shift-Mod-z': redo }),
          keymap(baseKeymap),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // 外部文本变化时替换文档并重置光标。
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    if (value === serializedRef.current) return
    serializedRef.current = value
    hadSelectionRef.current = false
    view.updateState(EditorState.create({ doc: promptToDoc(value), plugins: view.state.plugins }))
  }, [value])

  useEffect(() => {
    for (const chip of chipsRef.current) chip.refresh()
  }, [frames, highlighted])

  const closeMention = frameMention.close
  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !readOnly })
    if (readOnly) closeMention()
  }, [closeMention, readOnly])

  return (
    <>
      <div className={cn('prompt-editor', className)} ref={hostRef} />
      {frameMention.menu === undefined ? null : (
        <FrameMentionMenu {...frameMention.menu} frames={frames} ratio={ratio} />
      )}
    </>
  )
}
