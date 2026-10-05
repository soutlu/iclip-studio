import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { Markdown } from './markdown'

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

describe('Markdown 重渲染', () => {
  it('同样的正文重渲染不重建段落节点：选区与焦点挂在原节点上，换掉就丢了', () => {
    const { rerender } = renderWithTooltip(<Markdown text={'第一段，带 **粗体**。\n\n第二段'} />)
    const paragraph = screen.getByText('第二段')
    const bold = screen.getByText('粗体')

    rerender(<Markdown text={'第一段，带 **粗体**。\n\n第二段'} />)

    expect(screen.getByText('第二段')).toBe(paragraph)
    expect(screen.getByText('粗体')).toBe(bold)
  })
})

describe('Markdown 换行', () => {
  it('段落内的单个换行显示为换行，逐行字段不接成一行', () => {
    renderWithTooltip(
      <Markdown text={'**镜头语言**：硬切，手持\n**画面**：街口\n**BGM**：鼓点\n'} />,
    )
    const paragraph = screen.getByText('镜头语言').closest('p')
    if (paragraph === null) throw new Error('缺少段落')

    expect(paragraph.querySelectorAll('br')).toHaveLength(2)
    expect(within(paragraph).getByText('画面')).toBeInTheDocument()
    expect(within(paragraph).getByText('BGM')).toBeInTheDocument()
  })

  it('围栏代码块里的换行保留为原文，不换成 <br>', () => {
    const { container } = renderWithTooltip(<Markdown text={'```\n第一行\n第二行\n```\n'} />)

    expect(container.querySelector('br')).toBeNull()
    expect(container.querySelector('pre')).toHaveTextContent('第一行\n第二行', {
      normalizeWhitespace: false,
    })
  })
})

describe('Markdown 代码块', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fenced 代码块带头部条：语言名，点复制把原文写进剪贴板', async () => {
    // userEvent.setup 会替换剪贴板，断言用替身须随后安装。
    const user = userEvent.setup()
    const writeText = stubClipboard()
    renderWithTooltip(<Markdown text={'```json\n{\n  "shots": 3\n}\n```\n'} />)

    expect(screen.getByText('json')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制代码' }))

    expect(writeText).toHaveBeenCalledWith('{\n  "shots": 3\n}\n')
  })

  it('没有语言标记的代码块，头部条写作 text', () => {
    stubClipboard()
    renderWithTooltip(<Markdown text={'```\n纯文本\n```\n'} />)
    expect(screen.getByText('text')).toBeInTheDocument()
  })

  it('混合代码块与行内代码时保留两处原文', () => {
    renderWithTooltip(
      <Markdown text={'```\n第一行\n第二行\n```\n\n写进 `shots/storyboard.md`\n'} />,
    )
    expect(screen.getByText('第一行 第二行')).toBeVisible()
    expect(screen.getByText('shots/storyboard.md')).toBeVisible()
  })

  it('GFM 表格渲染成表头与单元格', () => {
    renderWithTooltip(
      <Markdown text={'| 结构 | 出场 |\n| :--- | :--- |\n| Open Hook | 女模特 |\n'} />,
    )
    expect(screen.getByRole('columnheader', { name: '结构' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Open Hook' })).toBeInTheDocument()
  })
})

describe('Markdown 媒体', () => {
  it('正文图片点开进灯箱；链接里的图片交给链接', async () => {
    const user = userEvent.setup()
    renderWithTooltip(
      <Markdown
        text={
          '![商品主图](https://images.example.test/a.png)\n\n[![参考](https://images.example.test/b.png)](https://example.test/b)\n'
        }
      />,
    )

    await user.click(screen.getByRole('button', { name: '放大图片：商品主图' }))
    const dialog = screen.getByRole('dialog', { name: '商品主图' })
    expect(within(dialog).getByRole('img', { name: '商品主图' })).toHaveAttribute(
      'src',
      'https://images.example.test/a.png',
    )
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('button', { name: '放大图片：参考' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '参考' })).toHaveAttribute(
      'href',
      'https://example.test/b',
    )
  })

  it('正文视频换成不带原生控件的共享播放器，放大进灯箱', async () => {
    const user = userEvent.setup()
    renderWithTooltip(
      <Markdown
        text={
          '样片：<video src="https://videos.example.test/a.mp4" controls muted></video>\n\n<video><source src="https://videos.example.test/b.mp4" type="video/mp4"></video>\n'
        }
      />,
    )

    const [inline, fromSource] = screen.getAllByLabelText<HTMLVideoElement>('视频', {
      selector: 'video',
    })
    expect(inline).toHaveAttribute('src', 'https://videos.example.test/a.mp4')
    expect(inline?.controls).toBe(false)
    expect(inline?.muted).toBe(false)
    expect(fromSource).toHaveAttribute('src', 'https://videos.example.test/b.mp4')

    const [enlarge] = screen.getAllByRole('button', { name: '放大' })
    if (enlarge === undefined) throw new Error('缺少放大按钮')
    await user.click(enlarge)
    const dialog = screen.getByRole('dialog', { name: '视频' })
    expect(within(dialog).getByLabelText('视频', { selector: 'video' })).toHaveAttribute(
      'src',
      'https://videos.example.test/a.mp4',
    )
  })
})
