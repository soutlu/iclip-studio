import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { MarkdownEditor, MarkdownPreview } from './markdown-editor'

const PROMPT = '## 角色\n\n你是**视频导演**，善用*参考片*。\n\n- 先理解需求\n- 再拆解参考片'

/** jsdom 没有排版，点击定不了光标：直接把 DOM 选区放到这段末尾，再告诉 ProseMirror 选区变了。 */
const placeCaretAtEnd = (block: HTMLElement) => {
  const text = block.lastChild as Text
  document.getSelection()?.collapse(text, text.length)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('MarkdownEditor', () => {
  it('读进 markdown 排好版，编辑后交出序列化的 markdown，原有格式都还在', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithTooltip(<MarkdownEditor ariaLabel="系统提示词" onChange={onChange} value={PROMPT} />)

    const editor = screen.getByRole('textbox', { name: '系统提示词' })
    expect(editor.querySelector('h2')).toHaveTextContent('角色')
    expect(editor.querySelector('strong')).toHaveTextContent('视频导演')
    expect(editor.querySelectorAll('li')).toHaveLength(2)
    // 没改过就不交值，调用方的原文不被改写。
    expect(onChange).not.toHaveBeenCalled()

    await user.click(editor)
    placeCaretAtEnd(editor.querySelectorAll('li p')[1] as HTMLElement)
    await user.keyboard('与镜头')

    // 序列化器的写法：无序列表统一用 `*`，紧凑列表不空行。
    expect(onChange).toHaveBeenLastCalledWith(
      '## 角色\n\n你是**视频导演**，善用*参考片*。\n\n* 先理解需求\n* 再拆解参考片与镜头',
    )
  })

  it('工具栏把选中的文字加粗、把段落变成标题与列表，按钮的按下状态跟着光标', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [value, setValue] = useState('卖点')
      return (
        <>
          <MarkdownEditor ariaLabel="系统提示词" onChange={setValue} value={value} />
          <output>{value}</output>
        </>
      )
    }
    renderWithTooltip(<Harness />)

    const editor = screen.getByRole('textbox', { name: '系统提示词' })
    await user.click(editor.querySelector('p') as HTMLElement)
    await user.keyboard('{Control>}a{/Control}')
    await user.click(screen.getByRole('button', { name: '加粗' }))
    expect(screen.getByRole('status')).toHaveTextContent('**卖点**')
    expect(screen.getByRole('button', { name: '加粗' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: '标题' }))
    expect(screen.getByRole('status')).toHaveTextContent('## **卖点**')

    await user.click(screen.getByRole('button', { name: '标题' }))
    await user.click(screen.getByRole('button', { name: '有序列表' }))
    expect(screen.getByRole('status')).toHaveTextContent('1. **卖点**')
    expect(screen.getByRole('button', { name: '有序列表' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('外部换了内容（恢复版本）时整篇重载', () => {
    const { rerender } = renderWithTooltip(
      <MarkdownEditor ariaLabel="系统提示词" onChange={vi.fn()} value="旧的提示词" />,
    )
    rerender(<MarkdownEditor ariaLabel="系统提示词" onChange={vi.fn()} value="## 新的提示词" />)

    const editor = screen.getByRole('textbox', { name: '系统提示词' })
    expect(editor.querySelector('h2')).toHaveTextContent('新的提示词')
    expect(editor).not.toHaveTextContent('旧的提示词')
  })
})

describe('MarkdownPreview', () => {
  it('按同一套排版只读显示', () => {
    renderWithTooltip(<MarkdownPreview value={PROMPT} />)
    expect(screen.getByRole('heading', { name: '角色' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})
