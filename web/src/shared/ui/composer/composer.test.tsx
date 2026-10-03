import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { EditorView } from 'prosemirror-view'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropFilesIntoWindow,
  pasteFilesIntoComposer,
  pasteTextIntoComposer,
} from '@/testing/editor'
import { serializePromptContent } from '@/shared/lib/prompt-clipboard'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { Composer, type ComposerHandle } from './composer'
import type { ComposerSubmission } from './use-composer-attachments'

const editor = () => screen.getByLabelText('输入消息')
const sendButton = () => screen.getByRole('button', { name: '发送' })
const imageFile = (name = '截图.png', type = 'image/png') =>
  new File(['fake-png-bytes'], name, { type })
const videoFile = (name = '样片.mp4') => new File(['fake-mp4-bytes'], name, { type: 'video/mp4' })

/** 只在正文里找：失败卡片与悬停卡上也有文件名。 */
const pillHost = (name: string): HTMLElement => {
  const host = within(editor()).getByText(name).parentElement
  if (host === null) throw new Error(`没找到 ${name} 的 pill`)
  return host
}

describe('Composer', () => {
  // jsdom 不解码图片；附件上传前的尺寸校验读这个桩。
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('空输入时发送禁用，粘入文字后放开，Enter 触发提交', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    expect(sendButton()).toBeDisabled()

    pasteTextIntoComposer(editor(), '做一个产品宣传片')
    expect(sendButton()).toBeEnabled()
    // 没在跑时写了字也没有排队提示。
    expect(screen.queryByText('发送后排队，这一轮结束再跑')).toBeNull()

    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({
      media: [],
      parts: [{ kind: 'text', text: '做一个产品宣传片' }],
      text: '做一个产品宣传片',
    })
  })

  it('IME 组字期间的 Enter 是选字，不触发提交', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    pasteTextIntoComposer(editor(), '正在输入')
    fireEvent.keyDown(editor(), { isComposing: true, key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('跑着的时候：空着只有停止；写了字发送钮亮出来，停止照旧在，点发送照常提交', async () => {
    const onSubmit = vi.fn()
    const onStop = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Composer busy onStop={onStop} onSubmit={onSubmit} />)

    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.queryByText('发送后排队，这一轮结束再跑')).toBeNull()

    pasteTextIntoComposer(editor(), '顺便配个音')

    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
    // 排队提示在输入卡上方，不挤在控件行里。
    const hint = screen.getByText('发送后排队，这一轮结束再跑')
    expect(sendButton().parentElement).not.toContainElement(hint)
    expect(hint.compareDocumentPosition(editor()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledWith({
      media: [],
      parts: [{ kind: 'text', text: '顺便配个音' }],
      text: '顺便配个音',
    })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('Shift+Enter 换行不提交', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    pasteTextIntoComposer(editor(), '第一行')
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor().textContent).toContain('\n')
  })

  it('粘贴图片落成内联 pill，传完才能发，发送带上公网地址', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])

    expect(screen.getByText('截图.png')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    await waitFor(() => expect(sendButton()).toBeEnabled())
    await user.click(sendButton())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submission = onSubmit.mock.calls[0]?.[0] as {
      media: { kind: string; url: string }[]
      text: string
    }
    expect(submission.text).toBe('')
    expect(submission.media).toHaveLength(1)
    expect(submission.media[0]?.kind).toBe('image')
    expect(submission.media[0]?.url).toContain('/mock-oss/')
  })

  it('粘贴复制来的消息：正文与附件一起落回输入框，地址原样复用不再上传', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const url = 'https://bkt.oss-ap-southeast-1.aliyuncs.com/u/S6-1.jpg'
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    // 粘的就是气泡复制出的那串文本，带缩进与换行。
    pasteTextIntoComposer(
      editor(),
      serializePromptContent([
        { text: '照这条再跑一次：', type: 'text' },
        { source: { kind: 'url', url }, type: 'image' },
      ]),
    )

    expect(screen.getByText('S6-1.jpg')).toBeInTheDocument()
    expect(editor().textContent).toContain('照这条再跑一次：')
    expect(sendButton()).toBeEnabled()
    await user.click(sendButton())

    const submission = onSubmit.mock.calls[0]?.[0] as {
      media: { kind: string; url: string }[]
      text: string
    }
    expect(submission.text).toBe('照这条再跑一次：')
    expect(submission.media).toEqual([expect.objectContaining({ kind: 'image', url })])
  })

  it('上传失败：pill 换成警示、发送一直被挡；点 pill 弹出失败卡片给出原因', async () => {
    const onSubmit = vi.fn()
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '不收 image/png 这个类型' }, { status: 422 }),
      ),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])

    const pill = pillHost('截图.png')
    expect(await within(pill).findByRole('img', { name: '上传失败' })).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    // 失败的 pill 不再出悬停预览，改为点开卡片。
    fireEvent.click(pill)
    const card = await screen.findByRole('dialog', { name: '截图.png上传失败' })
    expect(within(card).getByText(/不收 image\/png 这个类型/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '移除' })).toBeInTheDocument()
  })

  it('失败卡片点「重试」：用原文件重新上传，传完发送解锁并带上公网地址', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    // 按本用例独有的 webp 类型认请求：第一次签名失败，重试时交给默认 handler。
    let webpSigns = 0
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        const { contentType } = (await request.clone().json()) as { contentType: string }
        if (contentType !== 'image/webp') return undefined
        webpSigns += 1
        return webpSigns === 1
          ? HttpResponse.json({ detail: '签名服务暂时不可用' }, { status: 503 })
          : undefined
      }),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile('纹理.webp', 'image/webp')])
    const pill = pillHost('纹理.webp')
    await within(pill).findByRole('img', { name: '上传失败' })

    fireEvent.click(pill)
    const card = await screen.findByRole('dialog', { name: '纹理.webp上传失败' })
    await user.click(within(card).getByRole('button', { name: '重试' }))

    expect(screen.queryByRole('dialog', { name: '纹理.webp上传失败' })).not.toBeInTheDocument()
    await waitFor(() => expect(sendButton()).toBeEnabled())
    expect(webpSigns).toBe(2)
    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({
            name: '纹理.webp',
            url: expect.stringContaining('/mock-oss/'),
          }),
        ],
      }),
    )
  })

  it('失败卡片点「移除」：pill 从正文消失，焦点回输入框，剩下的文字可以发送', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '签名服务暂时不可用' }, { status: 503 }),
      ),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={vi.fn()} />)

    pasteTextIntoComposer(editor(), '参考这张')
    pasteFilesIntoComposer(editor(), [imageFile()])
    const pill = pillHost('截图.png')
    await within(pill).findByRole('img', { name: '上传失败' })
    expect(sendButton()).toBeDisabled()

    fireEvent.click(pill)
    const card = await screen.findByRole('dialog', { name: '截图.png上传失败' })
    await user.click(within(card).getByRole('button', { name: '移除' }))

    expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '截图.png上传失败' })).not.toBeInTheDocument()
    expect(editor()).toHaveFocus()
    expect(editor().textContent).toBe('参考这张')
    expect(sendButton()).toBeEnabled()
  })

  it('键盘：方向键选中失败的 pill，Enter 打开卡片并聚焦「重试」，Esc 关掉后焦点回输入框', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '签名服务暂时不可用' }, { status: 503 }),
      ),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    await within(pillHost('截图.png')).findByRole('img', { name: '上传失败' })

    // 粘贴后光标在 pill 之后；PM 按 keyCode 分发，左移一步选中整个原子节点。
    fireEvent.keyDown(editor(), { key: 'ArrowLeft', keyCode: 37 })
    fireEvent.keyDown(editor(), { key: 'Enter' })

    const card = await screen.findByRole('dialog', { name: '截图.png上传失败' })
    await waitFor(() => expect(within(card).getByRole('button', { name: '重试' })).toHaveFocus())
    expect(onSubmit).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '截图.png上传失败' })).not.toBeInTheDocument()
    await waitFor(() => expect(editor()).toHaveFocus())
  })

  it('退格删掉 pill 之后正文空了，发送重新禁用', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())

    // 验证 PM captureKeyDown 的 stopNativeHorizontalDelete：退格删除完整原子节点。
    fireEvent.keyDown(editor(), { key: 'Backspace', keyCode: 8 })

    await waitFor(() => expect(screen.queryByText('截图.png')).not.toBeInTheDocument())
    expect(sendButton()).toBeDisabled()
  })

  it('图片传好后撤销再重做：pill 带着条目回来，发送可用，提交带上这张图', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    editor().focus()
    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())

    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument())
    expect(sendButton()).toBeDisabled()

    await user.keyboard('{Control>}y{/Control}')
    expect(await within(editor()).findByText('截图.png')).toBeInTheDocument()
    // 重做带回来的 pill 不是空壳：状态与地址都在，不必重新上传就能发。
    expect(sendButton()).toBeEnabled()
    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submission = onSubmit.mock.calls[0]?.[0] as { media: { url: string }[] }
    expect(submission.media).toHaveLength(1)
    expect(submission.media[0]?.url).toContain('/mock-oss/')
  })

  it('发送后清空，撤销把正文与 pill 一起带回来，附件仍可再发', async () => {
    const ref = createRef<ComposerHandle>()
    const onSubmit = vi.fn<(submission: ComposerSubmission) => void>(() => ref.current?.clear())
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} ref={ref} />)

    editor().focus()
    pasteTextIntoComposer(editor(), '参考这张')
    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())
    // 等过 500ms 的分组间隔：这条验证撤销能把条目带回来；500ms 内发送的情形见下一条。
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)))
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument())

    await userEvent.keyboard('{Control>}z{/Control}')
    expect(await within(editor()).findByText('截图.png')).toBeInTheDocument()
    expect(editor()).toHaveTextContent('参考这张')
    expect(sendButton()).toBeEnabled()
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({
      media: [expect.objectContaining({ url: expect.stringContaining('/mock-oss/') })],
      text: '参考这张',
    })
  })

  it('打完字立刻发送再撤销：清空单独一步，正文连最后几个字与 pill 一起回来；重做回到清空', async () => {
    const ref = createRef<ComposerHandle>()
    const onSubmit = vi.fn<(submission: ComposerSubmission) => void>(() => ref.current?.clear())
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} ref={ref} />)

    editor().focus()
    pasteTextIntoComposer(editor(), '参考这张')
    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)))
    // 最后补几个字马上发送：这次编辑与清空落在同一个 500ms 分组窗口里。
    pasteTextIntoComposer(editor(), '，竖版')
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument())

    await userEvent.keyboard('{Control>}z{/Control}')
    expect(await within(editor()).findByText('截图.png')).toBeInTheDocument()
    // 补的字接在 pill 后面，分开断言。
    expect(editor()).toHaveTextContent('参考这张')
    expect(editor()).toHaveTextContent('，竖版')
    expect(sendButton()).toBeEnabled()

    await userEvent.keyboard('{Control>}y{/Control}')
    await waitFor(() => expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument())
    expect(editor()).not.toHaveTextContent('参考这张')
    expect(sendButton()).toBeDisabled()
  })

  it('发送后紧接着打下一条再撤销：只撤掉新打的，发出去的那条不跟着回来', async () => {
    const ref = createRef<ComposerHandle>()
    const onSubmit = vi.fn<(submission: ComposerSubmission) => void>(() => ref.current?.clear())
    await renderWithProviders(<Composer onSubmit={onSubmit} ref={ref} />)

    editor().focus()
    pasteTextIntoComposer(editor(), '第一条')
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)))
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(editor()).not.toHaveTextContent('第一条'))

    // 清空之后 500ms 内就开始打下一条。
    pasteTextIntoComposer(editor(), '下一条')
    await userEvent.keyboard('{Control>}z{/Control}')

    await waitFor(() => expect(editor()).not.toHaveTextContent('下一条'))
    expect(editor()).not.toHaveTextContent('第一条')
    expect(sendButton()).toBeDisabled()
  })

  it('拖文件进窗口：先出全屏遮罩，松手落成 pill、遮罩消失', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    const file = imageFile()
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => null }],
      types: ['Files'],
    }
    fireEvent.dragEnter(window, { dataTransfer })
    expect(screen.getByTestId('composer-drop-overlay')).toBeInTheDocument()

    fireEvent.drop(window, { dataTransfer })
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    expect(screen.getByText('截图.png')).toBeInTheDocument()
    await waitFor(() => expect(sendButton()).toBeEnabled())
  })

  it('拖入聊天编辑器按落点插入附件，过滤目录且不会被窗口重复上传', async () => {
    const onSubmit = vi.fn()
    const uploadRequested = vi.fn()
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === '/api/uploads/sign') uploadRequested()
    })
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)
    pasteTextIntoComposer(editor(), '正文')
    // jsdom 没有布局，将实际 drop 事件的命中位置固定在正文之前。
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ inside: 0, pos: 1 })

    const file = imageFile()
    const dataTransfer = {
      files: [file, new File([], '图片目录')],
      getData: () => '',
      items: [
        { kind: 'file', type: file.type, webkitGetAsEntry: () => null },
        { kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
      types: ['Files'],
    }
    fireEvent.dragEnter(window, { dataTransfer })
    fireEvent.drop(editor(), { clientX: 10, clientY: 10, dataTransfer })

    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    expect(screen.getAllByText('截图.png')).toHaveLength(1)
    expect(screen.queryByText('图片目录')).not.toBeInTheDocument()
    await waitFor(() => expect(sendButton()).toBeEnabled())
    expect(uploadRequested).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({
      media: [expect.objectContaining({ name: '截图.png' })],
      parts: [
        { kind: 'media', media: expect.objectContaining({ name: '截图.png' }) },
        { kind: 'text', text: '正文' },
      ],
      text: '正文',
    })
  })

  it('局部区域接管拖放后不添加聊天附件，并清理已有遮罩与拖放深度', async () => {
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={vi.fn()} />)

    const file = imageFile()
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => null }],
      types: ['Files'],
    }
    fireEvent.dragEnter(window, { dataTransfer })
    expect(screen.getByTestId('composer-drop-overlay')).toBeInTheDocument()

    const enter = createEvent.dragEnter(window, { dataTransfer })
    enter.preventDefault()
    fireEvent(window, enter)
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()

    fireEvent.dragOver(window, { dataTransfer })
    expect(screen.getByTestId('composer-drop-overlay')).toBeInTheDocument()
    const over = createEvent.dragOver(window, { dataTransfer })
    over.preventDefault()
    fireEvent(window, over)
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()

    fireEvent.dragOver(window, { dataTransfer })
    const drop = createEvent.drop(window, { dataTransfer })
    drop.preventDefault()
    fireEvent(window, drop)
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    expect(screen.queryByText('截图.png')).not.toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    fireEvent.dragEnter(window, { dataTransfer })
    fireEvent.dragLeave(window, { dataTransfer })
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
  })

  it('拖到正文上方时编辑器自己的 preventDefault 不算别处接管，遮罩照常亮着', async () => {
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={vi.fn()} />)
    const file = imageFile()
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => null }],
      types: ['Files'],
    }

    // ProseMirror 对可编辑区的 dragenter / dragover 一律 preventDefault，再冒到 window。
    const enter = createEvent.dragEnter(editor(), { dataTransfer })
    enter.preventDefault()
    fireEvent(editor(), enter)
    expect(screen.getByTestId('composer-drop-overlay')).toBeInTheDocument()
    const over = createEvent.dragOver(editor(), { dataTransfer })
    over.preventDefault()
    fireEvent(editor(), over)
    expect(screen.getByTestId('composer-drop-overlay')).toBeInTheDocument()

    fireEvent.dragLeave(editor(), { dataTransfer })
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
  })

  it('attachmentsEnabled 未给时：没有附件入口，拖入也不出遮罩', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()

    dropFilesIntoWindow([imageFile()])
    expect(screen.queryByText('截图.png')).not.toBeInTheDocument()
  })

  it('上传中不允许提交（Enter 与按钮都挡），pill 显示上传中', async () => {
    const onSubmit = vi.fn()
    server.use(
      http.post('*/api/uploads/sign', async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    expect(await screen.findByText('截图.png')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    // pill 本身显示上传中：拿不到进度时是不确定的进度条；悬停预览照旧，报「上传中」。
    const pill = pillHost('截图.png')
    const progress = within(pill).getByRole('progressbar', { name: '上传中' })
    expect(progress).not.toHaveAttribute('aria-valuenow')
    fireEvent.mouseEnter(pill)
    const tip = await screen.findByRole('tooltip')
    expect(within(tip).getByText('上传中')).toBeInTheDocument()
  })

  it('悬停 pill 出预览卡，传完后卡上报文件大小而不是上传状态', async () => {
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={vi.fn()} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())

    fireEvent.mouseEnter(pillHost('截图.png'))

    const tip = await screen.findByRole('tooltip')
    // 'fake-png-bytes' 共 14 字节；jsdom 不加载图片，所以没有像素尺寸。
    expect(within(tip).getByText('14 B')).toBeInTheDocument()
    expect(within(tip).queryByText('已上传')).not.toBeInTheDocument()
  })

  it('视频 pill 传完后，卡上的「放大」进灯箱', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={vi.fn()} />)

    pasteFilesIntoComposer(editor(), [videoFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())

    fireEvent.mouseEnter(pillHost('样片.mp4'))
    const tip = await screen.findByRole('tooltip')
    await user.click(within(tip).getByRole('button', { name: '放大' }))

    const dialog = screen.getByRole('dialog', { name: '样片.mp4' })
    expect(dialog.querySelector('video')).not.toBeNull()
  })

  it('点图片 pill 本身进灯箱，Esc 关掉后焦点回到输入框', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={vi.fn()} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())

    // jsdom 没有 elementFromPoint，走不通 PM 的 mousedown；先聚焦输入框，再只发 click。
    editor().focus()
    fireEvent.click(pillHost('截图.png'))
    expect(await screen.findByRole('dialog', { name: '截图.png' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '截图.png' })).not.toBeInTheDocument()
    await waitFor(() => expect(editor()).toHaveFocus())
  })
})
