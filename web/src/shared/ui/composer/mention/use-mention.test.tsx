import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { baseKeymap } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { useEffect, useRef, type Ref } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DialogRoot, DialogSurface, DialogTitle } from '@/shared/ui/dialog'
import { selectMention } from './mention-plugin'
import { useMention } from './use-mention'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: {},
  },
})

const WORDS = ['cat', 'car', 'dog']

/** 最小使用方：候选按查询词前缀筛选，选中后把 `@` 与查询词换成那个词。 */
function MentionEditor({ query }: { query: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const mention = useMention(viewRef, {
    onPick: (index, { match, view }) => {
      const word = WORDS.filter((item) => item.startsWith(match.query))[index]
      if (word === undefined) return
      selectMention(view)
      view.dispatch(view.state.tr.insertText(word))
    },
    query,
  })
  const createPluginRef = useRef(mention.createPlugin)
  useEffect(() => {
    if (hostRef.current === null) return undefined
    const view = new EditorView(hostRef.current, {
      attributes: { 'aria-label': '正文', role: 'textbox' },
      state: EditorState.create({
        plugins: [createPluginRef.current(), keymap(baseKeymap)],
        schema,
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])
  const { menu } = mention
  return (
    <>
      <div ref={hostRef} />
      {menu === undefined ? null : (
        <Candidates
          active={menu.active}
          listRef={menu.listRef}
          onPick={menu.pick}
          words={WORDS.filter((word) => word.startsWith(menu.match.query))}
        />
      )}
    </>
  )
}

type CandidatesProps = {
  active: number
  listRef: Ref<HTMLUListElement>
  onPick: (index: number) => void
  words: readonly string[]
}

function Candidates({ active, listRef, onPick, words }: CandidatesProps) {
  return (
    <ul aria-label="候选" ref={listRef} role="listbox">
      {words.map((word, index) => (
        <li key={word} role="presentation">
          <button
            aria-selected={index === active}
            onClick={() => onPick(index)}
            // 按下不抢焦点：编辑器失焦会关菜单。
            onMouseDown={(event) => event.preventDefault()}
            role="option"
            tabIndex={-1}
            type="button"
          >
            {word}
          </button>
        </li>
      ))}
    </ul>
  )
}

const editorOf = () => screen.getByRole('textbox', { name: '正文' })
const queryMenu = () => screen.queryByRole('listbox', { name: '候选' })
const optionNames = () =>
  within(screen.getByRole('listbox', { name: '候选' }))
    .queryAllByRole('option')
    .map((option) => option.textContent)

const focusEditor = () => act(() => editorOf().focus())

/** 把 DOM 光标放到第一段第 `offset` 个字之前，经 selectionchange 交给 ProseMirror。 */
const moveCaret = (offset: number) => {
  const text = editorOf().querySelector('p')?.firstChild
  if (text == null) throw new Error('正文第一段应当有文字')
  act(() => {
    document.getSelection()?.collapse(text, offset)
    fireEvent(document, new Event('selectionchange'))
  })
}

describe('useMention 查询模式', () => {
  it('敲 @ 打开，@ 之后到光标之前的字是查询词，候选随之筛选；↓ 加 Enter 由使用方换掉 @ 与查询词', async () => {
    render(<MentionEditor query />)
    focusEditor()
    await userEvent.keyboard('@')
    expect(optionNames()).toEqual(['cat', 'car', 'dog'])

    await userEvent.keyboard('ca')
    expect(optionNames()).toEqual(['cat', 'car'])
    await userEvent.keyboard('t')
    expect(optionNames()).toEqual(['cat'])
    // 光标退回查询词中间：查询词只算到光标为止。
    moveCaret(3)
    expect(optionNames()).toEqual(['cat', 'car'])
    expect(screen.getByRole('option', { name: 'cat' })).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(queryMenu()).not.toBeInTheDocument()
    expect(editorOf()).toHaveTextContent(/^cart$/)
  })

  it('点候选同样插入', async () => {
    render(<MentionEditor query />)
    focusEditor()
    await userEvent.keyboard('@d')
    await userEvent.click(screen.getByRole('option', { name: 'dog' }))
    expect(editorOf()).toHaveTextContent(/^dog$/)
  })

  it.each([
    ['光标挪到 @ 之前', async () => moveCaret(1)],
    ['查询词里敲了空格', () => userEvent.keyboard(' ')],
  ])('%s就关', async (_, leave) => {
    render(<MentionEditor query />)
    focusEditor()
    await userEvent.keyboard('先@ca')
    expect(queryMenu()).toBeInTheDocument()
    await leave()
    expect(queryMenu()).not.toBeInTheDocument()
  })

  it('候选被筛空时 Enter 不选也不换行', async () => {
    render(<MentionEditor query />)
    focusEditor()
    await userEvent.keyboard('@x')
    expect(optionNames()).toEqual([])
    await userEvent.keyboard('{Enter}')
    expect(queryMenu()).toBeInTheDocument()
    expect(editorOf().querySelectorAll('p')).toHaveLength(1)
    expect(editorOf()).toHaveTextContent(/^@x$/)
  })

  it('在弹窗里 Esc 只关菜单，@ 与查询词留着；再按一次 Esc 才关弹窗', async () => {
    const onOpenChange = vi.fn()
    render(
      <DialogRoot onOpenChange={onOpenChange} open>
        <DialogSurface aria-describedby={undefined}>
          <DialogTitle>编辑</DialogTitle>
          <MentionEditor query />
        </DialogSurface>
      </DialogRoot>,
    )
    focusEditor()
    await userEvent.keyboard('@ca')
    expect(queryMenu()).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(queryMenu()).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(editorOf()).toHaveTextContent(/^@ca$/)

    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('useMention 非查询模式', () => {
  it('@ 之后敲任何字就关，字面 @ 留着', async () => {
    render(<MentionEditor query={false} />)
    focusEditor()
    await userEvent.keyboard('@')
    expect(optionNames()).toEqual(['cat', 'car', 'dog'])
    await userEvent.keyboard('c')
    expect(queryMenu()).not.toBeInTheDocument()
    expect(editorOf()).toHaveTextContent(/^@c$/)
  })
})
