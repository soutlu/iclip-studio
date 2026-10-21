/**
 * 画面上原位改字：在合成页的元素上直接打字，改完写回草稿。能改的是组件里带 data-var-text 标记的字
 * （那一项可填项），和字幕的一句（`caption:N`）；都没有时双击不响应，同 HyperFrames。
 */
import type { PlacedCaption } from './composition/captions'
import { clearCaptionText, setCaptionText } from './editing/captions'
import type { WholeFilmDraft } from './editing/draft'
import type { EditResult } from './editing/result'
import { setComponentVariables } from './editing/variables'

/** 双击处能改的字所在的元素：带标记的可填项，或一句字幕 */
export const EDITABLE_TEXT = '[data-var-text], [data-hf-id^="caption:"]'

/**
 * 改一句字幕的字：没变返回 null（不记编辑）；清空或等于识别结果时撤销改字，否则记这句的新字。
 * `current` 是改之前这句的字（改过的字或识别结果）。时间线与画面上改字共用。
 */
export function captionTextEdit(
  draft: WholeFilmDraft,
  args: { caption: PlacedCaption; text: string; current: string; recognized: string },
): EditResult | null {
  const { caption, current, recognized } = args
  const text = args.text.trim()
  if (text === current) return null
  const sentence = { subtitleJobId: caption.subtitleJobId, sentenceIndex: caption.sentenceIndex }
  return text === '' || text === recognized
    ? clearCaptionText(draft, sentence)
    : setCaptionText(draft, { ...sentence, text })
}

/**
 * 改组件片段（组件段或特效块）的一项文字：只换这一项，其余可填项照旧。没变返回 null（不记编辑）；
 * 清空时去掉这一项、回到组件的默认字，同设置浮层。`shown` 是改之前画面上的字。
 */
export function componentTextEdit(
  draft: WholeFilmDraft,
  args: { id: string; variable: string; text: string; shown: string },
): EditResult | null {
  const { id, variable, shown } = args
  const text = args.text.trim()
  if (text === shown.trim()) return null
  const piece =
    draft.overlays.find((overlay) => overlay.id === id) ??
    draft.layer0.find((clip) => clip.id === id && clip.type === 'component')
  const current = piece !== undefined && 'variables' in piece ? piece.variables : {}
  const variables =
    text === ''
      ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== variable))
      : { ...current, [variable]: text }
  return setComponentVariables(draft, { id, variables })
}

/** 有自己的非空白文字（不算子元素里的）的元素；同 SDK 墨迹判断里的口径 */
const hasOwnText = (element: Element) =>
  [...element.childNodes].some(
    (node) => node.nodeType === node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  )

type Removed = { node: Node; parent: Node; next: Node | null }

/**
 * 记下元素里现在的内容，返回放回去的函数。存的是副本：打字会就地改掉原来的文字节点。
 */
function keepContent(element: HTMLElement) {
  const children = [...element.childNodes].map((node) => node.cloneNode(true))
  return () => element.replaceChildren(...children)
}

/**
 * 把一句字幕的元素换成整句文字：字放进第一个有字的元素，其余带字的逐词元素先拿掉；
 * 不带字的（如高亮底块）留着。返回放字的元素与恢复原样的函数。
 */
function collapseToText(root: HTMLElement, text: string) {
  const leaf =
    [root, ...root.querySelectorAll<HTMLElement>('*')].find((element) => hasOwnText(element)) ??
    root
  const removed: Removed[] = []
  for (let node: HTMLElement = leaf; node !== root;) {
    const parent = node.parentElement
    if (parent === null) break
    for (const sibling of [...parent.children]) {
      if (sibling === node || (sibling.textContent ?? '').trim() === '') continue
      removed.push({ node: sibling, parent, next: sibling.nextSibling })
      sibling.remove()
    }
    node = parent
  }
  const restoreLeaf = keepContent(leaf)
  leaf.textContent = text
  const restore = () => {
    restoreLeaf()
    // 倒着放回：每一个的后邻在它被拿掉时就在、或是更晚拿掉（先放回）的那个
    for (const { node, parent, next } of removed.reverse()) parent.insertBefore(node, next)
  }
  return { target: leaf, restore }
}

/**
 * 改字时的样子：字外一圈细白框（与选中框同一套白框加深色外圈），光标白色，折行以免长句出画。
 * 这些样式写在合成页（iframe）里的元素上，跟着画面缩放，所以框线按屏幕上的像素折算（`pixel`）；
 * 那里也取不到我们的设计 token。
 */
const editingStyle = (pixel: number): Readonly<Record<string, string>> => ({
  outline: 'none',
  'border-radius': `${3 * pixel}px`,
  // design-allow -- 写进合成页 iframe 的行内样式，那里取不到设计 token
  'box-shadow': `0 0 0 ${pixel}px rgb(255 255 255 / 90%), 0 0 0 ${2 * pixel}px rgb(0 0 0 / 25%)`,
  // design-allow -- 写进合成页 iframe 的行内样式，那里取不到设计 token
  'caret-color': '#fff',
  cursor: 'text',
  'user-select': 'text',
  '-webkit-user-select': 'text',
  'white-space': 'pre-wrap',
})

export type TextEditOptions = {
  /** 先把元素里的字换成它（字幕换成整句，拿掉逐词的元素）；不给时就改元素现在的字 */
  text?: string
  /** 屏幕上的 1 像素合元素自己的多少 CSS 像素（画面缩放的倒数），默认 1 */
  pixel?: number
  /**
   * 回车或失焦时提交，收到元素里的字；返回 true 表示写进了草稿（预览会换页，元素保持改后的样子），
   * false 时元素恢复原样。
   */
  onCommit: (text: string) => boolean
  /** 结束（提交或放弃）后调用一次 */
  onEnd: () => void
}

/**
 * 在合成页的元素上原位改字：设为可编辑（纯文本）、聚焦并全选。回车（不带 Shift，不在输入法组字中）
 * 或失焦时提交，Esc 放弃并恢复原样；Esc 不再往外传。返回放弃这次编辑的函数。
 */
export function startTextEdit(element: HTMLElement, options: TextEditOptions): () => void {
  const doc = element.ownerDocument
  const { target, restore } =
    options.text === undefined
      ? { target: element, restore: keepContent(element) }
      : collapseToText(element, options.text)
  const style = target.getAttribute('style')
  for (const [name, value] of Object.entries(editingStyle(options.pixel ?? 1)))
    target.style.setProperty(name, value)
  target.setAttribute('contenteditable', 'plaintext-only')

  let ended = false
  const finish = (commit: boolean) => {
    if (ended) return
    ended = true
    target.removeEventListener('keydown', onKeyDown)
    target.removeEventListener('blur', onBlur)
    target.removeAttribute('contenteditable')
    if (style === null) target.removeAttribute('style')
    else target.setAttribute('style', style)
    doc.getSelection()?.removeAllRanges()
    const kept = commit && options.onCommit(target.textContent ?? '')
    if (!kept) restore()
    options.onEnd()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }
  const onBlur = () => finish(true)
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('blur', onBlur)

  target.focus()
  const range = doc.createRange()
  range.selectNodeContents(target)
  const selection = doc.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return () => finish(false)
}
