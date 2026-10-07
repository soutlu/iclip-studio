/** Composer 的可选扩展：使用方节点、`@` 菜单、卡片拖放、只收图片、附件上限、自定义入口与提交按钮、弹窗里的浮层。
 * 默认形态（首页、对话）见 composer.test.tsx。 */

import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { EditorView } from 'prosemirror-view'
import { createRef, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializePromptContent } from '@/shared/lib/prompt-clipboard'
import { DialogRoot, DialogSurface, DialogTitle } from '@/shared/ui/dialog'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { Composer, type ComposerHandle, type ComposerMention } from './composer'
import type { ComposerNodeSpec } from './composer-node'
import { readyAttachment } from './use-composer-attachments'

type TagNode = { name: 'tag'; attrs: { id: string } }
const tagSpec: ComposerNodeSpec<TagNode> = {
  attrNames: ['id'],
  leafText: (node) => `#${node.attrs.id}`,
  name: 'tag',
  render: (node) => <span className="media-chip">标签 {node.attrs.id}</span>,
}
const NODES = [tagSpec]
const tag = (id: string) => ({ kind: 'node', node: { attrs: { id }, name: 'tag' } }) as const

const FRAME_URL = 'https://example.com/frame-2.png'
type Item = { label: string; pick: 'tag' | 'frame' | 'blocked' }
const ITEMS: readonly Item[] = [
  { label: '标签 a', pick: 'tag' },
  { label: '帧 @2', pick: 'frame' },
  { label: '满了', pick: 'blocked' },
]
const mention: ComposerMention<Item, TagNode> = {
  items: (query) => ITEMS.filter((item) => item.label.includes(query)),
  partsOf: (item) =>
    item.pick === 'tag'
      ? [tag('a')]
      : item.pick === 'frame'
        ? [
            {
              kind: 'media',
              media: readyAttachment({ kind: 'image', name: '帧 @2', url: FRAME_URL }),
            },
          ]
        : undefined,
  render: (menu) => (
    <ul aria-label="插入引用" ref={menu.listRef} role="listbox">
      {menu.items.map((item, index) => (
        <li key={item.label} role="presentation">
          <button
            aria-selected={index === menu.active}
            onClick={() => menu.onPick(index)}
            onMouseDown={(event) => event.preventDefault()}
            role="option"
            tabIndex={-1}
            type="button"
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  ),
}

const editor = () => screen.getByRole('textbox', { name: '修改要求' })
const imageFile = (name = '截图.png') => new File(['fake-png-bytes'], name, { type: 'image/png' })
const videoFile = () => new File(['fake-mp4-bytes'], '样片.mp4', { type: 'video/mp4' })
const fileDrag = (files: File[]) => ({
  files,
  getData: () => '',
  items: files.map((file) => ({ kind: 'file', type: file.type, webkitGetAsEntry: () => null })),
  types: ['Files'],
})
/** 只在正文里找：失败卡片与悬停卡上也有文件名。 */
const pillHost = (name: string): HTMLElement => {
  const host = within(editor()).getByText(name).parentElement
  if (host === null) throw new Error(`没找到 ${name} 的 pill`)
  return host
}
const signRequests = () => {
  const signed = vi.fn()
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === '/api/uploads/sign') signed()
  })
  return signed
}

type EditComposerProps = Partial<ComponentProps<typeof Composer<TagNode, Item>>>

async function renderComposer(props: EditComposerProps = {}) {
  const ref = createRef<ComposerHandle<TagNode>>()
  const onSubmit = vi.fn()
  const onChange = vi.fn()
  const view = await renderWithProviders(
    <Composer<TagNode, Item>
      ariaLabel="修改要求"
      nodes={NODES}
      onChange={onChange}
      onSubmit={onSubmit}
      ref={ref}
      {...props}
    />,
  )
  return { onChange, onSubmit, ref, view }
}

describe('Composer 扩展点', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('使用方节点：句柄插入节点与就绪附件，提交与 onChange 都按文档顺序带上它们，纯文字里没有节点', async () => {
    const { onChange, onSubmit, ref } = await renderComposer()
    await waitFor(() => expect(ref.current).not.toBeNull())

    const frame = readyAttachment({ kind: 'image', name: '帧 @2', url: FRAME_URL })
    act(() =>
      ref.current?.insert([
        { kind: 'text', text: '把 ' },
        tag('a'),
        { kind: 'text', text: ' 换成 ' },
        { kind: 'media', media: frame },
      ]),
    )

    expect(within(editor()).getByText('标签 a')).toBeInTheDocument()
    const parts = [
      { kind: 'text', text: '把 ' },
      tag('a'),
      { kind: 'text', text: ' 换成 ' },
      { kind: 'media', media: frame },
    ]
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(parts))

    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ media: [frame], parts, text: '把  换成' })
  })

  it('整篇恢复不触发 onChange，之后的编辑照常触发', async () => {
    const { onChange, ref } = await renderComposer()
    await waitFor(() => expect(ref.current).not.toBeNull())

    act(() =>
      ref.current?.restore({
        media: [],
        parts: [tag('a'), { kind: 'text', text: '旧的' }],
        text: '',
      }),
    )
    expect(within(editor()).getByText('标签 a')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    pasteTextIntoComposer(editor(), '新的')
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([tag('a'), { kind: 'text', text: '旧的新的' }]),
    )
  })

  it('附件传完时 onChange 再触发一次，带上公网地址；进度不另触发', async () => {
    const { onChange } = await renderComposer({ attachmentsEnabled: true })

    pasteFilesIntoComposer(editor(), [imageFile()])

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([
        {
          kind: 'media',
          media: expect.objectContaining({
            status: 'ready',
            url: expect.stringContaining('/mock-oss/'),
          }),
        },
      ]),
    )
    const statuses = onChange.mock.calls.map(
      ([parts]) => (parts as [{ media: { status: string } }])[0].media.status,
    )
    expect(statuses).toEqual(['uploading', 'ready'])
  })

  it('@ 菜单：查询词筛选，Enter 把 @ 与查询词换成附件且不提交；不能选的项按 Enter 菜单留着', async () => {
    const user = userEvent.setup()
    const { onSubmit } = await renderComposer({ mention })
    act(() => editor().focus())

    // 不能选的项：Enter 不插入也不提交，菜单留着；Esc 关掉，字留着。
    await user.keyboard('@满')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('listbox', { name: '插入引用' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(editor().textContent).toBe('@满')

    await user.keyboard('，看@')
    const menu = screen.getByRole('listbox', { name: '插入引用' })
    expect(
      within(menu)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['标签 a', '帧 @2', '满了'])

    await user.keyboard('帧')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['帧 @2'])
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('listbox', { name: '插入引用' })).not.toBeInTheDocument()
    expect(within(editor()).getByText('帧 @2')).toBeInTheDocument()
    expect(editor().textContent).toBe('@满，看帧 @2')
    expect(onSubmit).not.toHaveBeenCalled()

    // 菜单关着时 Enter 回到发送。
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          { kind: 'text', text: '@满，看' },
          { kind: 'media', media: expect.objectContaining({ url: FRAME_URL }) },
        ],
      }),
    )
  })

  it('@ 菜单点选使用方节点；在弹窗里 Esc 先关菜单，弹窗留着', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    await renderWithProviders(
      <DialogRoot onOpenChange={onOpenChange} open>
        <DialogSurface aria-describedby={undefined}>
          <DialogTitle>编辑</DialogTitle>
          <Composer<TagNode, Item>
            ariaLabel="修改要求"
            dropScope="card"
            mention={mention}
            nodes={NODES}
            onSubmit={vi.fn()}
          />
        </DialogSurface>
      </DialogRoot>,
    )
    act(() => editor().focus())

    await user.keyboard('@')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '插入引用' })).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(editor().textContent).toBe('@')

    await user.keyboard('@')
    await user.click(screen.getByRole('option', { name: '标签 a' }))
    expect(editor().textContent).toBe('@标签 a')
  })

  it('卡片拖放：拖进来只在卡片上亮提示，落在卡片上收下一次；窗口别处不收', async () => {
    const signed = signRequests()
    await renderComposer({ attachmentsEnabled: true, dropScope: 'card' })
    const drag = fileDrag([imageFile()])

    // 落在卡片外：卡片模式不当整页兜底。
    fireEvent.dragEnter(window, { dataTransfer: drag })
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    fireEvent.drop(window, { dataTransfer: drag })
    expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument()

    const zone = screen.getByRole('button', { name: '发送' })
    fireEvent.dragEnter(zone, { dataTransfer: drag })
    const overlay = screen.getByTestId('composer-drop-overlay')
    expect(overlay.parentElement).toContainElement(editor())

    fireEvent.drop(zone, { dataTransfer: drag })
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    expect(within(editor()).getAllByText('截图.png')).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(signed).toHaveBeenCalledTimes(1)
  })

  it('卡片拖放：落在正文上由编辑器按落点插入，卡片见已接管不再收第二次', async () => {
    const signed = signRequests()
    await renderComposer({ attachmentsEnabled: true, dropScope: 'card' })
    pasteTextIntoComposer(editor(), '正文')
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ inside: 0, pos: 1 })
    const drag = fileDrag([imageFile()])

    fireEvent.dragEnter(editor(), { dataTransfer: drag })
    fireEvent.drop(editor(), { clientX: 10, clientY: 10, dataTransfer: drag })

    expect(within(editor()).getAllByText('截图.png')).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(signed).toHaveBeenCalledTimes(1)
  })

  it('卡片拖放：没有上传权限时落下拒收、不亮提示', async () => {
    await renderComposer({ dropScope: 'card' })
    const drag = fileDrag([imageFile()])
    const zone = screen.getByRole('button', { name: '发送' })

    const over = createEvent.dragOver(zone, { dataTransfer: drag })
    fireEvent(zone, over)
    expect(over.defaultPrevented).toBe(true)
    expect(drag).toMatchObject({ dropEffect: 'none' })
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    fireEvent.drop(zone, { dataTransfer: drag })
    expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument()
  })

  it("accept='image'：选文件只列图片，视频停在失败「只能添加图片」，粘贴来的消息里视频项丢掉", async () => {
    const { view } = await renderComposer({ accept: 'image', attachmentsEnabled: true })
    const input = view.container.querySelector('input[type="file"]')
    expect(input?.getAttribute('accept')).toMatch(/^image\//)

    pasteFilesIntoComposer(editor(), [videoFile()])
    fireEvent.click(pillHost('样片.mp4'))
    const card = await screen.findByRole('dialog', { name: '样片.mp4上传失败' })
    expect(within(card).getByText('只能添加图片')).toBeInTheDocument()

    pasteTextIntoComposer(
      editor(),
      serializePromptContent([
        { text: '照这条：', type: 'text' },
        { source: { kind: 'url', url: 'https://example.com/a.mp4' }, type: 'video' },
        { source: { kind: 'url', url: 'https://example.com/b.png' }, type: 'image' },
      ]),
    )
    expect(within(editor()).getByText('b.png')).toBeInTheDocument()
    expect(within(editor()).queryByText('a.mp4')).not.toBeInTheDocument()
  })

  it('附件上限：超出的文件不收，卡内就地提示没收几个；下一次没超就收起提示', async () => {
    let remaining = 1
    await renderComposer({
      attachmentLimit: {
        notice: (dropped) => `最多引用 2 张，这次有 ${dropped} 张没有添加`,
        remaining: () => remaining,
      },
      attachmentsEnabled: true,
    })

    pasteFilesIntoComposer(editor(), [
      imageFile('一.png'),
      imageFile('二.png'),
      imageFile('三.png'),
    ])

    expect(within(editor()).getByText('一.png')).toBeInTheDocument()
    expect(within(editor()).queryByText('二.png')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-notice')).toHaveTextContent(
      '最多引用 2 张，这次有 2 张没有添加',
    )

    remaining = 1
    pasteFilesIntoComposer(editor(), [imageFile('四.png')])
    expect(within(editor()).getByText('四.png')).toBeInTheDocument()
    expect(screen.getByTestId('composer-notice')).toBeEmptyDOMElement()
  })

  it('submitAction 换成带文字的提交按钮：空着禁用，提交中换文字并挡住重复提交', async () => {
    const submitAction = {
      emphasis: 'primary',
      icon: 'image',
      label: '生成图片',
      pendingLabel: '提交中…',
    } as const
    const { onSubmit, view } = await renderComposer({ submitAction })

    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成图片' })).toBeDisabled()
    pasteTextIntoComposer(editor(), '换成蓝色')
    await userEvent.click(screen.getByRole('button', { name: '生成图片' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    view.unmount()
    const pending = await renderComposer({ sending: true, submitAction })
    pasteTextIntoComposer(editor(), '换成蓝色')
    expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled()
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(pending.onSubmit).not.toHaveBeenCalled()
  })

  it('addControl 代替默认的添加按钮，附件不可用时也照样出现', async () => {
    await renderComposer({
      addControl: (openFilePicker) => (
        <button onClick={openFilePicker} type="button">
          插入参考图
        </button>
      ),
    })
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '插入参考图' })).toBeInTheDocument()
  })

  describe('在模态弹窗里', () => {
    const renderInDialog = () =>
      renderWithProviders(
        <DialogRoot open>
          <DialogSurface aria-describedby={undefined}>
            <DialogTitle>编辑图片</DialogTitle>
            <Composer ariaLabel="修改要求" attachmentsEnabled dropScope="card" onSubmit={vi.fn()} />
          </DialogSurface>
        </DialogRoot>,
      )

    it('悬停预览卡挂进弹窗，卡上「放大」能点开灯箱', async () => {
      const user = userEvent.setup()
      await renderInDialog()
      const dialog = screen.getByRole('dialog', { name: '编辑图片' })

      pasteFilesIntoComposer(editor(), [imageFile()])
      await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
      fireEvent.mouseEnter(pillHost('截图.png'))
      const tip = await within(dialog).findByRole('tooltip')
      await user.click(within(tip).getByRole('button', { name: '放大' }))

      expect(await screen.findByRole('dialog', { name: '截图.png' })).toBeInTheDocument()
    })

    it('失败卡片也挂在弹窗里，键盘能进到「移除」', async () => {
      const user = userEvent.setup()
      server.use(
        http.post('*/api/uploads/sign', async () => {
          await delay(1)
          return HttpResponse.json({ detail: '签名服务暂时不可用' }, { status: 503 })
        }),
      )
      await renderInDialog()
      const dialog = screen.getByRole('dialog', { name: '编辑图片' })

      pasteFilesIntoComposer(editor(), [imageFile()])
      await within(pillHost('截图.png')).findByRole('img', { name: '上传失败' })
      fireEvent.keyDown(editor(), { key: 'ArrowLeft', keyCode: 37 })
      fireEvent.keyDown(editor(), { key: 'Enter' })

      const card = await within(dialog).findByRole('dialog', { name: '截图.png上传失败' })
      await waitFor(() => expect(within(card).getByRole('button', { name: '重试' })).toHaveFocus())
      await user.tab()
      expect(within(card).getByRole('button', { name: '移除' })).toHaveFocus()
      await user.keyboard('{Enter}')
      expect(within(editor()).queryByText('截图.png')).not.toBeInTheDocument()
    })
  })
})
