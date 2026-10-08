import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePromptContent } from '@/shared/lib/prompt-clipboard'
import type {
  PromptContentPart,
  ToolCallFrame,
  TranscriptInteraction,
  TranscriptTurn,
} from '@/shared/transcript/vendor'
import { ArtifactRegistry } from '@/shared/workbench'
import { renderWithProviders, renderWithTooltip } from '@/testing/render'
import { ConversationTurn } from './conversation-turn'
import { UserBubble } from './user-bubble'

/** jsdom 不执行布局，显式模拟超过十行的内容高度。 */
const stubOverflowing = () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
  const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
  return () => {
    scroll.mockRestore()
    client.mockRestore()
  }
}

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

const text = (value: string): PromptContentPart => ({ text: value, type: 'text' })
const image = (url: string): PromptContentPart => ({ source: { kind: 'url', url }, type: 'image' })
const video = (url: string): PromptContentPart => ({ source: { kind: 'url', url }, type: 'video' })

describe('UserBubble', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('短消息不折叠，没有展开胶囊', () => {
    renderWithTooltip(<UserBubble content={[text('就一句')]} />)
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull()
  })

  it('超长消息折叠成渐隐，点「展开」放开全文', async () => {
    restore = stubOverflowing()
    const user = userEvent.setup()
    renderWithTooltip(<UserBubble content={[text('一行长长的素材说明\n'.repeat(20))]} />)

    const toggle = await screen.findByRole('button', { name: '展开' })
    await user.click(toggle)

    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })

  it('气泡下有复制钮：纯文字消息复制的是文字 part 原样接起来的正文；没给 onEdit 就没有修改钮', async () => {
    // 在 user-event 初始化后安装剪贴板替身，避免被其覆盖。
    const user = userEvent.setup()
    const writeText = stubClipboard()
    renderWithTooltip(<UserBubble content={[text('先看这句：'), text('\n还有这句')]} />)

    await user.click(screen.getByRole('button', { name: '复制消息' }))

    expect(writeText).toHaveBeenCalledWith('先看这句：\n还有这句')
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()
  })

  it('带附件的消息复制成接口 content，粘回输入框能连附件一起还原', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    const content = [
      text('先看这张图：'),
      image('https://bkt.oss-ap-southeast-1.aliyuncs.com/u/S6-1.jpg'),
      text('\n说明它写了什么'),
    ]
    renderWithTooltip(<UserBubble content={content} />)

    await user.click(screen.getByRole('button', { name: '复制消息' }))

    const copied = writeText.mock.calls[0]?.[0] as string
    expect(parsePromptContent(copied)).toEqual(content)
  })

  it('图夹在两句话中间：芯片就画在那两句话中间，头部是这张图的缩略图', () => {
    const url = 'https://bkt.oss-ap-southeast-1.aliyuncs.com/u/S6-1.jpg'
    renderWithTooltip(
      <UserBubble content={[text('先看这张图：'), image(url), text('\n说明它写了什么')]} />,
    )

    const chip = screen.getByRole('button', { name: 'S6-1.jpg' })
    const before = screen.getByText('先看这张图：')
    const after = screen.getByText(/说明它写了什么/)
    expect(before.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chip.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chip.querySelector('img')?.getAttribute('src')).toBe(
      `${url}?x-oss-process=image/resize,l_64`,
    )
  })

  it('视频芯片：OSS 地址给首帧缩略图，其他来源画视频图标', () => {
    renderWithTooltip(
      <UserBubble
        content={[
          video('https://bkt.oss-ap-southeast-1.aliyuncs.com/u/demo.mp4'),
          video('https://example.com/clip.mp4'),
        ]}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'demo.mp4' }).querySelector('img')?.getAttribute('src'),
    ).toContain('x-oss-process=video/snapshot')
    expect(screen.getByRole('button', { name: 'clip.mp4' }).querySelector('img')).toBeNull()
  })

  it('点图片芯片开灯箱，灯箱里是图', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<UserBubble content={[image('https://example.com/reference.png')]} />)

    await user.click(screen.getByRole('button', { name: 'reference.png' }))

    expect(screen.getByRole('dialog', { name: 'reference.png' })).toBeInTheDocument()
    // 芯片缩略图为装饰图片，具名图片只能来自灯箱。
    expect(screen.getByRole('img', { name: 'reference.png' })).toBeInTheDocument()
  })

  it('点视频芯片开灯箱，灯箱里是能播的视频', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<UserBubble content={[video('https://example.com/clip.mp4')]} />)

    await user.click(screen.getByRole('button', { name: 'clip.mp4' }))

    const dialog = screen.getByRole('dialog', { name: 'clip.mp4' })
    expect(dialog.querySelector('video')).not.toBeNull()
  })
})

describe('UserBubble 媒体芯片的悬停卡', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** 计时器推进包在 act 中，确保对应状态更新完成。 */
  const advance = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  /** 先越过跨芯片共享的快速重开窗口，再测量当前卡片时序。 */
  const renderChip = () => {
    renderWithTooltip(<UserBubble content={[image('https://example.com/reference.png')]} />)
    advance(500)
    return screen.getByRole('button', { name: 'reference.png' })
  }

  it('悬停 150ms 后出卡，离开 120ms 后收起', () => {
    const chip = renderChip()

    fireEvent.mouseEnter(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
    advance(150)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(chip)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    advance(120)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('光标从芯片移进卡里，卡不收起', () => {
    const chip = renderChip()

    fireEvent.mouseEnter(chip)
    advance(150)
    fireEvent.mouseLeave(chip)
    fireEvent.mouseEnter(screen.getByRole('tooltip'))
    advance(500)

    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })
})

const turnWithFrames = (frames: TranscriptTurn['steps'][number]['frames']): TranscriptTurn => ({
  content: [text('先做开场镜头')],
  kind: 'turn',
  ordinal: 1,
  origin: { kind: 'user' },
  state: 'completed',
  steps: [
    {
      frames: [...frames],
      kind: 'step',
      ordinal: 1,
      state: 'completed',
      stepId: 't1.1',
      turnId: 't1',
    },
  ],
  turnId: 't1',
})

/** 分镜文件登记成产物，与 app 层的登记一致：对话里照写文件名，点了进分镜面板。 */
const registry = () => {
  const value = new ArtifactRegistry()
  value.register({
    autoOpen: true,
    component: () => null,
    icon: 'grid',
    label: '分镜',
    match: { path: 'video_shot.json' },
    title: () => '分镜',
    type: 'storyboard',
  })
  return value
}

type RenderTurnOptions = {
  interactions?: ReadonlyMap<string, TranscriptInteraction>
  onRegenerate?: () => void
}

const turnElement = (turn: TranscriptTurn, options: RenderTurnOptions = {}) => (
  <ConversationTurn
    interactions={options.interactions ?? new Map()}
    onRegenerate={options.onRegenerate}
    turn={turn}
  />
)

const renderTurn = (turn: TranscriptTurn, options: RenderTurnOptions = {}) =>
  renderWithProviders(turnElement(turn, options), {
    initialPath: '/c/conv-1',
    registry: registry(),
  })

describe('ConversationTurn', () => {
  afterEach(() => vi.restoreAllMocks())

  it('已经有模型块时仍显示轮头部的开场输入', async () => {
    await renderTurn(
      turnWithFrames([
        { frameId: 't1.1.f1', kind: 'thinking', text: '先分析素材' },
        { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: '已经完成。' },
      ]),
    )

    expect(screen.getByText('先做开场镜头')).toBeInTheDocument()
    expect(screen.getByText('已经完成。')).toBeInTheDocument()
  })

  it('开场输入与中途插话各自显示一次', async () => {
    await renderTurn(
      turnWithFrames([
        {
          content: [text('再补一个特写')],
          frameId: 't1.1.f1',
          kind: 'text',
          role: 'user',
          text: '再补一个特写',
        },
        { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: '收到。' },
      ]),
    )

    expect(screen.getAllByText('先做开场镜头')).toHaveLength(1)
    expect(screen.getAllByText('再补一个特写')).toHaveLength(1)
  })

  it('只有一张图的开场输入也显示用户气泡', async () => {
    await renderTurn({
      ...turnWithFrames([]),
      content: [image('https://example.com/reference.png')],
    })

    expect(screen.getByRole('button', { name: 'reference.png' })).toBeInTheDocument()
  })

  it('回复结束后复制最后一次用户输入之后的助手原始 markdown', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    await renderTurn(
      turnWithFrames([
        { frameId: 't1.1.f1', kind: 'text', role: 'assistant', text: '前一段回复' },
        {
          content: [text('再补一个结尾')],
          frameId: 't1.1.f2',
          kind: 'text',
          role: 'user',
          text: '再补一个结尾',
        },
        { frameId: 't1.1.f3', kind: 'thinking', text: '调整结构' },
        { frameId: 't1.1.f4', kind: 'text', role: 'assistant', text: '## 最终回复' },
        { frameId: 't1.1.f5', kind: 'text', role: 'assistant', text: '补充说明' },
      ]),
    )

    await user.click(screen.getByRole('button', { name: '复制' }))

    expect(writeText).toHaveBeenCalledWith('## 最终回复\n\n补充说明')
  })

  it('回复仍在输出时不显示复制按钮', async () => {
    stubClipboard()
    await renderTurn({
      ...turnWithFrames([
        { frameId: 't1.1.f1', kind: 'text', role: 'assistant', text: '还在输出' },
      ]),
      state: 'running',
    })

    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
  })
})

const mediaFrame = (metadata: unknown) => ({
  display: { kind: 'generic' as const, summary: '出镜头帧' },
  frameId: 't1.1.f1',
  kind: 'tool' as const,
  metadata,
  name: 'generate_shot_frames',
  output: '出好了 2 张',
  state: 'done' as const,
  toolCallId: 'call_1',
  view: 'media_grid',
})

const TWO_ITEMS = {
  items: [
    { caption: 'S01 · 产品特写', url: 'https://example.com/a.png' },
    { caption: 'S02 · 场景全景', url: 'https://example.com/b.png' },
  ],
}

const fileTool = (
  frameId: string,
  operation: 'read' | 'write' | 'edit',
  path: string,
  fields: Partial<ToolCallFrame> = {},
): ToolCallFrame => ({
  display: { kind: 'file_io', operation, path },
  frameId,
  kind: 'tool',
  name: `${operation}_file`,
  state: 'done',
  toolCallId: frameId,
  ...fields,
})

describe('工具结果按 view 选渲染器', () => {
  it('media_grid 在工具行下面画出每一张图与它的标题', async () => {
    await renderTurn(turnWithFrames([mediaFrame(TWO_ITEMS)]))

    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'S01 · 产品特写' })).toBeInTheDocument()
    expect(screen.getByText('S02 · 场景全景')).toBeInTheDocument()
  })

  it('media_grid 没带标题的图只画图、不写标题，带标题的照常写', async () => {
    await renderTurn(
      turnWithFrames([
        mediaFrame({
          items: [
            { url: 'https://example.com/a.png' },
            { caption: 'S02 · 场景全景', url: 'https://example.com/b.png' },
          ],
        }),
      ]),
    )

    const figures = screen.getAllByRole('figure')
    expect(figures).toHaveLength(2)
    expect(figures[0]).toContainElement(screen.getByRole('img', { name: '图片' }))
    expect(figures[0]?.querySelector('figcaption')).toBeNull()
    expect(figures[1]).toHaveTextContent('S02 · 场景全景')
  })

  it('点一张图开灯箱', async () => {
    const user = userEvent.setup()
    await renderTurn(turnWithFrames([mediaFrame(TWO_ITEMS)]))

    await user.click(screen.getByRole('button', { name: 'S01 · 产品特写' }))

    expect(screen.getByRole('dialog', { name: 'S01 · 产品特写' })).toBeInTheDocument()
  })

  it('结果形状对不上就退回朴素行：没有图，一句话的结果也不给展开', async () => {
    await renderTurn(turnWithFrames([mediaFrame({ items: 3 })]))

    expect(screen.queryByRole('figure')).toBeNull()
    expect(screen.getByText('出镜头帧')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /出镜头帧/ })).toBeNull()
  })

  it('读文件：行尾不写行数；展开是去掉行号的文件内容，md 排成文档，续读提示不出现', async () => {
    const user = userEvent.setup()
    await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'read', 'shots/storyboard.md', {
          metadata: { lines: 3, path: 'shots/storyboard.md', truncated: true },
          output:
            '     1\t# 分镜\n     2\t\n     3\tS01 产品特写\n[还有 6 行没读，接着从第 4 行读]',
          view: 'file_content',
        }),
      ]),
    )

    expect(screen.queryByText(/3 行/)).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开「读取文件 storyboard.md」的详情' }))

    expect(screen.getByRole('heading', { name: '分镜' })).toBeInTheDocument()
    expect(screen.getByText('S01 产品特写')).toBeInTheDocument()
    expect(screen.queryByText(/还有 6 行没读/)).toBeNull()
    expect(screen.queryByText(/^\s*1\s*$/)).toBeNull()
  })

  it('详情面板第一次展开才排版正文', async () => {
    const user = userEvent.setup()
    await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'write', 'notes/剪辑说明.md', {
          display: {
            content: '节奏前慢后快',
            kind: 'file_io',
            operation: 'write',
            path: 'notes/剪辑说明.md',
          },
        }),
      ]),
    )

    expect(screen.queryByText('节奏前慢后快')).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开「写入文件 剪辑说明.md」的详情' }))
    expect(screen.getByText('节奏前慢后快')).toBeInTheDocument()
  })

  it('改文件：行尾没有增删数；展开是改动行，删的在前、加的在后', async () => {
    const user = userEvent.setup()
    await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'edit', 'shots/storyboard.md', {
          display: {
            after: '镜头 2\n景别：中景',
            before: '镜头 2\n景别：近景',
            kind: 'file_io',
            operation: 'edit',
            path: 'shots/storyboard.md',
          },
          metadata: { added: 1, removed: 1 },
          output: '已改 shots/storyboard.md（现在 4312 字节）',
        }),
      ]),
    )

    expect(screen.queryByText('+1')).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开「编辑文件 storyboard.md」的详情' }))

    const diff = screen.getByRole('region', { name: '改动' })
    expect(diff).toHaveTextContent('镜头 2−删去：景别：近景+新写：景别：中景')
  })

  it('检索：行尾写命中数，展开是逐条命中（文件名 + 命中的那一行）', async () => {
    const user = userEvent.setup()
    await renderTurn(
      turnWithFrames([
        {
          display: { kind: 'search', query: '夜景' },
          frameId: 't1.1.f1',
          kind: 'tool',
          metadata: {
            matches: [
              { file: 'shots/s01.md', line: 4, text: '开场是夜景' },
              { file: 'shots/s02.md', line: 9, text: '结尾也是夜景' },
            ],
            query: '夜景',
            truncated: true,
          },
          name: 'search_files',
          output: 'shots/s01.md:4\t开场是夜景\nshots/s02.md:9\t结尾也是夜景',
          state: 'done',
          toolCallId: 'call_1',
          view: 'search_results',
        },
      ]),
    )

    expect(screen.getByText('2 处命中')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '展开「搜索工作区 夜景」的详情' }))

    expect(screen.getByRole('button', { name: /s02\.md\s*结尾也是夜景/ })).toBeInTheDocument()
    expect(screen.getByText('命中较多，仅列出部分结果')).toBeInTheDocument()
  })

  it('画出图的那次调用不折进活动组：折起来图就跟着不见了', async () => {
    await renderTurn(
      turnWithFrames([fileTool('t1.1.f0', 'read', 'shots/storyboard.md'), mediaFrame(TWO_ITEMS)]),
    )

    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.queryByText(/读取了 1 个文件/)).toBeNull()
  })
})

describe('文件名在工作台打开', () => {
  it('文件名只写文件名，点了在「文件」页打开那一份；点文件名不展开这一行', async () => {
    const user = userEvent.setup()
    const { router } = await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'write', '/notes//剪辑说明.md', {
          display: {
            content: '节奏',
            kind: 'file_io',
            operation: 'write',
            path: '/notes//剪辑说明.md',
          },
        }),
      ]),
    )

    await user.click(screen.getByRole('button', { name: '剪辑说明.md' }))

    expect(router.state.location.search).toMatchObject({
      artifact: 'workspace',
      file: 'notes/剪辑说明.md',
    })
    expect(
      screen.getByRole('button', { name: '展开「写入文件 剪辑说明.md」的详情' }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('登记成产物的文件照写文件名，点了进它自己的面板', async () => {
    const user = userEvent.setup()
    const { router } = await renderTurn(
      turnWithFrames([fileTool('t1.1.f1', 'edit', 'video_shot.json')]),
    )

    await user.click(screen.getByRole('button', { name: 'video_shot.json' }))

    expect(router.state.location.search).toMatchObject({ artifact: 'file:video_shot.json' })
  })

  it('路径对不上工作区文件就只写字，不给按钮', async () => {
    await renderTurn(turnWithFrames([fileTool('t1.1.f1', 'read', 'shots/../a.md')]))

    expect(screen.getByText('a.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'a.md' })).toBeNull()
  })
})

describe('每次调用按自己的状态画', () => {
  const rejected = (toolCallId: string): ReadonlyMap<string, TranscriptInteraction> =>
    new Map([
      [
        'appr_1',
        { interactionId: 'appr_1', interactionKind: 'approval', state: 'rejected', toolCallId },
      ],
    ])

  it('审批被拒绝的调用：灰 × 加「已拒绝」，文件名不可点，没有详情，不算失败', async () => {
    await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'write', 'shots/cover.md', {
          approvalId: 'appr_1',
          error: '用户拒绝了这次调用',
          state: 'error',
        }),
      ]),
      { interactions: rejected('t1.1.f1') },
    )

    expect(screen.getByText('已拒绝')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '失败' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'cover.md' })).toBeNull()
    expect(screen.queryByRole('button', { name: /详情/ })).toBeNull()
  })

  it('同样的调用，审批没有被拒绝就是普通失败：红 ×，展开是错误原文', async () => {
    const user = userEvent.setup()
    await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'write', 'shots/cover.md', {
          approvalId: 'appr_1',
          error: '运行中断，这次调用没有结果',
          state: 'error',
        }),
      ]),
    )

    expect(screen.getByRole('img', { name: '失败' })).toBeInTheDocument()
    expect(screen.queryByText('已拒绝')).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开「写入文件 cover.md」的详情' }))
    expect(screen.getByText('错误信息')).toBeInTheDocument()
    expect(screen.getByText('运行中断，这次调用没有结果')).toBeInTheDocument()
  })

  it('成功的调用不画状态图标', async () => {
    await renderTurn(turnWithFrames([fileTool('t1.1.f1', 'read', 'a.md')]))

    expect(screen.queryByRole('img', { name: /失败|完成|进行中/ })).toBeNull()
  })

  it('轮已结束、调用仍是 running：照协议画运行中，不替它改成完成', async () => {
    await renderTurn(turnWithFrames([fileTool('t1.1.f1', 'read', 'a.md', { state: 'running' })]))

    expect(screen.getByRole('img', { name: '进行中' })).toBeInTheDocument()
  })
})

describe('活动组的开合', () => {
  const groupFrames = (state: 'running' | 'done') => [
    { frameId: 't1.1.f1', kind: 'thinking' as const, text: '先读分镜' },
    fileTool('t1.1.f2', 'read', 'shots/需求.md'),
    fileTool('t1.1.f3', 'edit', 'shots/storyboard.md', {
      error: '参数校验失败：shots[2].duration 需要数字',
      state: 'error',
    }),
    fileTool('t1.1.f4', 'edit', 'shots/storyboard.md', { state }),
  ]
  const runningTurn: TranscriptTurn = {
    ...turnWithFrames(groupFrames('running')),
    state: 'running',
  }
  const doneTurn = turnWithFrames(groupFrames('done'))

  it('运行中自动展开，跑完自动收起；收起后失败的那一行仍露在卡头下面，成功的行收进去', async () => {
    const { rerender } = await renderTurn(runningTurn)

    const header = screen.getByRole('button', { name: /^进行中：/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('button', { name: '需求.md' })).toHaveLength(1)

    rerender(turnElement(doneTurn))

    expect(screen.getByRole('button', { name: /^有失败：/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: '需求.md' })).toBeNull()
    expect(screen.getAllByRole('img', { name: '失败' })).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: '展开「编辑文件 storyboard.md」的详情' }),
    ).toBeInTheDocument()
  })

  it('运行中只在正在跑的工具行画转圈，卡头不另画；卡头的可访问名照旧标「进行中」', async () => {
    await renderTurn(runningTurn)

    const header = screen.getByRole('button', { name: /^进行中：/ })
    // 卡头里的图形对读屏隐藏、没有可访问名，只能数图形：只剩展开箭头一个。
    expect(header.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getAllByRole('img', { name: '进行中' })).toHaveLength(1)
  })

  it('卡头写失败次数；全部成功的组结束后收起，不露任何一行', async () => {
    await renderTurn(doneTurn)
    expect(screen.getByRole('button', { name: /（1 失败）/ })).toBeInTheDocument()

    await renderTurn(
      turnWithFrames([
        { frameId: 't2.1.f1', kind: 'thinking', text: '先读分镜' },
        fileTool('t2.1.f2', 'read', 'shots/甲.md'),
      ]),
    )
    expect(screen.getByRole('button', { name: /^完成：/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: '甲.md' })).toBeNull()
  })

  it('用户点开以后就以用户为准', async () => {
    const user = userEvent.setup()
    await renderTurn(doneTurn)

    await user.click(screen.getByRole('button', { name: /^有失败：/ }))

    expect(screen.getByRole('button', { name: /^有失败：/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('button', { name: '需求.md' })).toBeInTheDocument()
  })
})

describe('结果入口', () => {
  it('跑完的轮列出写成、改成的文件，去重按出现顺序；没成功的不列', async () => {
    await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'write', 'notes/剪辑说明.md'),
        fileTool('t1.1.f2', 'edit', 'video_shot.json'),
        fileTool('t1.1.f3', 'edit', 'notes/剪辑说明.md'),
        fileTool('t1.1.f4', 'write', 'notes/失败.md', { error: 'x', state: 'error' }),
        { frameId: 't1.1.f5', kind: 'text', role: 'assistant', text: '好了。' },
      ]),
    )

    const list = screen.getByRole('list', { name: '这一轮的结果' })
    const items = within(list).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([
      '剪辑说明.md已编辑',
      'video_shot.json已编辑',
    ])
  })

  it('点结果在工作台打开那份文件', async () => {
    const user = userEvent.setup()
    const { router } = await renderTurn(
      turnWithFrames([
        fileTool('t1.1.f1', 'edit', 'video_shot.json'),
        { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: '好了。' },
      ]),
    )

    await user.click(within(screen.getByRole('list', { name: '这一轮的结果' })).getByRole('button'))

    expect(router.state.location.search).toMatchObject({ artifact: 'file:video_shot.json' })
  })

  it('还在跑的轮不列结果', async () => {
    await renderTurn({
      ...turnWithFrames([fileTool('t1.1.f1', 'write', 'notes/a.md')]),
      state: 'running',
    })

    expect(screen.queryByRole('list', { name: '这一轮的结果' })).toBeNull()
  })
})

describe('轮次没跑完', () => {
  const failedTurn = (frames: TranscriptTurn['steps'][number]['frames'] = []): TranscriptTurn => ({
    ...turnWithFrames(frames),
    error: 'UnexpectedModelBehavior("Tool \'write_video_shots\' exceeded max retries")',
    state: 'failed',
  })

  it('一行「该轮未完成」，错误原文不铺开，「复制错误信息」复制的就是它', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    await renderTurn(failedTurn())

    expect(screen.getByText('该轮未完成')).toBeInTheDocument()
    expect(screen.queryByText(/UnexpectedModelBehavior/)).toBeNull()

    await user.click(screen.getByRole('button', { name: '复制错误信息' }))

    expect(writeText).toHaveBeenCalledWith(
      'UnexpectedModelBehavior("Tool \'write_video_shots\' exceeded max retries")',
    )
  })

  it('能重新生成时给「重试」，点了就是重新生成；操作栏不再另给一个', async () => {
    const user = userEvent.setup()
    const onRegenerate = vi.fn()
    await renderTurn(
      failedTurn([{ frameId: 't1.1.f1', kind: 'text', role: 'assistant', text: '做到一半' }]),
      { onRegenerate },
    )

    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('不能重新生成时没有「重试」', async () => {
    await renderTurn(failedTurn())

    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })
})
