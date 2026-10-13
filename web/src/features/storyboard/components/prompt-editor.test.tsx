import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { PromptEditor, type PromptEditorHandle } from './prompt-editor'
import { docToPrompt, promptOffsetAt, promptToDoc } from './prompt-editor-doc'

const FIXTURES = [
  '她走向镜头 @Image1，脚步放慢。',
  '@Image1 开场\n收尾 @Image2',
  '第一行\n\n第三行 @Image3 尾巴',
  '  参考 @Image01\r\n\r\n末尾 @Image2。  \r\n',
  '[0–2秒｜镜头9]\n正文里的时间线样式文本\n',
  '前😀@Image01后\n\n尾@Image2',
  '',
  '只有文字，没有帧',
]

describe('promptToDoc / docToPrompt', () => {
  it.each(FIXTURES)('%j 往返保留原始字符串', (text) => {
    expect(docToPrompt(promptToDoc(text))).toBe(text)
  })

  it('选区偏移按 UTF-16 原文计算，包含完整帧标记、空行和表情', () => {
    const text = '前😀@Image01后\n\n尾@Image2'
    const doc = promptToDoc(text)
    expect(
      [1, 4, 5, 6, 8, 10, doc.content.size].map((position) => promptOffsetAt(doc, position)),
    ).toEqual([0, 3, 11, 12, 13, 14, text.length])
  })

  it('上传中的附件 chip 不进正文、在正文里占 0 个字符，前后文字的偏移与没有 chip 时相同', () => {
    const plain = promptToDoc('前文后文')
    const { schema } = plain.type
    const chip = schema.node('attachment', { attId: 'a1', kind: 'image', name: '新帧.png' })
    const withChip = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('前文'), chip, schema.text('后文')]),
    ])
    expect(docToPrompt(withChip)).toBe('前文后文')
    // 有 chip 的文档在 chip 处多一个位置：chip 前后两个位置都对应正文偏移 2。
    expect([1, 2, 3, 4, 5, 6, 7].map((position) => promptOffsetAt(withChip, position))).toEqual([
      0, 1, 2, 2, 3, 4, 4,
    ])
    expect([1, 2, 3, 4, 5].map((position) => promptOffsetAt(plain, position))).toEqual([
      0, 1, 2, 3, 4,
    ])
  })
})

describe('PromptEditor', () => {
  const value = '她走向镜头 @Image1，停下 @Image2。'
  const frames = ['data:image/svg+xml,a', 'data:image/svg+xml,b']

  it('帧标记带缩略图，点击时返回本组图片编号', async () => {
    let selected: number | undefined
    await renderWithProviders(
      <PromptEditor
        aria-label="镜头 1 的描述"
        aspectRatio="9:16"
        frames={frames}
        highlighted={1}
        onPickFrame={(number) => {
          selected = number
        }}
        value={value}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '镜头 1 的描述' })
    expect(editor).toHaveTextContent('她走向镜头 @1，停下 @2。')
    const chip = screen.getByRole('button', { name: '查看第 2 帧' })
    expect(chip.querySelector('img')).toHaveAttribute('src', frames[1])
    fireEvent.click(chip)
    expect(selected).toBe(2)
  })

  it('正文普通编辑与撤销不会改写已有标记、空白或换行', async () => {
    const original = '  前言 @Image01。\n\n收尾 @Image2。\n'
    let changed = original
    const ref = createRef<PromptEditorHandle>()
    await renderWithProviders(
      <PromptEditor
        aria-label="正文"
        aspectRatio="9:16"
        frames={frames}
        onChange={(next) => {
          changed = next
        }}
        ref={ref}
        value={original}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '正文' })
    editor.focus()
    pasteTextIntoComposer(editor, '新增')
    expect(changed).toBe(`新增${original}`)
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(changed).toBe(original)
    // 全选后插入引用：选区覆盖整段正文，整段换成这个引用。
    await userEvent.keyboard('{Control>}a{/Control}')
    act(() => ref.current?.insertFrame(1))
    expect(changed).toBe('@Image1')
  })

  it('多行粘贴保留原始帧标记并可继续选择该帧', async () => {
    const pasted = '  新内容 @Image02\n\n最后一行 @Image1。  '
    let changed = value
    await renderWithProviders(
      <PromptEditor
        aria-label="正文"
        aspectRatio="9:16"
        frames={frames}
        onChange={(next) => {
          changed = next
        }}
        value={value}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '正文' })
    editor.focus()
    await userEvent.keyboard('{Control>}a{/Control}')
    pasteTextIntoComposer(editor, pasted)
    expect(changed).toBe(pasted)
    expect(screen.getByRole('button', { name: '查看第 2 帧' })).toBeVisible()
  })

  it.each(['{Enter}', ' '])('帧标记可通过键盘 %s 激活', async (key) => {
    let selected: number | undefined
    await renderWithProviders(
      <PromptEditor
        aria-label="正文"
        aspectRatio="9:16"
        frames={frames}
        onPickFrame={(number) => {
          selected = number
        }}
        value={value}
      />,
    )
    const chip = screen.getByRole('button', { name: '查看第 2 帧' })
    chip.focus()
    await userEvent.keyboard(key)
    expect(selected).toBe(2)
  })
})
