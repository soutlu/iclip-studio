import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SourceEditor } from './source-editor'

const TABLE = '## 镜头\n\n| 镜号 | 景别 |\n|:--|--:|\n| 1 | 特写 |\n\n正文**加粗**  \n下一行'

const textbox = () => screen.getByRole('textbox', { name: '文件内容' })

describe('SourceEditor', () => {
  it('挂载不交值；输入后交出原文，表格与其余字节原样不动', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SourceEditor ariaLabel="文件内容" kind="markdown" onChange={onChange} value={TABLE} />)

    expect(textbox()).toHaveTextContent('| 镜号 | 景别 |')
    expect(onChange).not.toHaveBeenCalled()

    await user.click(textbox())
    await user.keyboard('{Control>}{End}{/Control}{ArrowLeft}')
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('字')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(`${TABLE.slice(0, -1)}字${TABLE.slice(-1)}`)
  })

  it('外部换值时整篇替换，不交值，也撤销不回旧内容', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <SourceEditor ariaLabel="文件内容" kind="markdown" onChange={onChange} value="旧的提示词" />,
    )
    await user.click(textbox())
    await user.keyboard('{Control>}{End}{/Control}。')
    expect(onChange).toHaveBeenLastCalledWith('旧的提示词。')

    rerender(
      <SourceEditor ariaLabel="文件内容" kind="markdown" onChange={onChange} value="新的提示词" />,
    )
    expect(textbox()).toHaveTextContent('新的提示词')
    expect(onChange).toHaveBeenCalledTimes(1)

    await user.click(textbox())
    await user.keyboard('{Control>}z{/Control}')
    expect(textbox()).toHaveTextContent('新的提示词')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('交出去的值原样传回来时不重载，撤销照常', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <SourceEditor ariaLabel="文件内容" kind="text" onChange={onChange} value="甲" />,
    )
    await user.click(textbox())
    await user.keyboard('{Control>}{End}{/Control}乙')
    rerender(<SourceEditor ariaLabel="文件内容" kind="text" onChange={onChange} value="甲乙" />)
    await user.keyboard('{Control>}z{/Control}')
    expect(onChange).toHaveBeenLastCalledWith('甲')
  })

  it('Tab 不插入内容，焦点移走', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <>
        <SourceEditor ariaLabel="文件内容" kind="markdown" onChange={onChange} value="正文" />
        <button type="button">下一个控件</button>
      </>,
    )
    await user.click(textbox())
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '下一个控件' })).toHaveFocus()
  })

  it('markdown 里 Mod-B 用 ** 包住选中的文字，再按一次去掉', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SourceEditor ariaLabel="文件内容" kind="markdown" onChange={onChange} value="卖点" />)
    await user.click(textbox())
    await user.keyboard('{Control>}a{/Control}{Control>}b{/Control}')
    expect(onChange).toHaveBeenLastCalledWith('**卖点**')
    await user.keyboard('{Control>}b{/Control}')
    expect(onChange).toHaveBeenLastCalledWith('卖点')
  })

  it('CRLF 的文件按 CRLF 交出', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SourceEditor ariaLabel="文件内容" kind="text" onChange={onChange} value={'一\r\n二'} />)
    await user.click(textbox())
    await user.keyboard('{Control>}{End}{/Control}三')
    expect(onChange).toHaveBeenLastCalledWith('一\r\n二三')
  })
})
