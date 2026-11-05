import type { PlacedCaption } from './composition/captions'
import { clearCaptionText, setCaptionText } from './editing/captions'
import type { WholeFilmDraft } from './editing/draft'
import type { EditResult } from './editing/result'
import { setComponentVariables } from './editing/variables'

export const EDITABLE_TEXT = '[data-var-text], [data-hf-id^="caption:"]'

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

const hasOwnText = (element: Element) =>
  [...element.childNodes].some(
    (node) => node.nodeType === node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  )

type Removed = { node: Node; parent: Node; next: Node | null }

function keepContent(element: HTMLElement) {
  const children = [...element.childNodes].map((node) => node.cloneNode(true))
  return () => element.replaceChildren(...children)
}

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
    for (const { node, parent, next } of removed.reverse()) parent.insertBefore(node, next)
  }
  return { target: leaf, restore }
}

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
  text?: string
  pixel?: number
  onCommit: (text: string) => boolean
  onEnd: () => void
}

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
