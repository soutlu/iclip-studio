import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { mockAuthUser } from '@/testing/mocks/auth-user'
import { loginAs } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { FrameImageEditor } from './frame-image-editor'
import { editDraftKey } from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  shotIndex: 1,
  frameNumber: 1,
}
const BASE = 'https://example.com/original.png'
const FRAME_2 = 'https://example.com/frame-2.png'
const RESULT = 'https://example.com/old-result.png'
const draft: FrameEditDraft = {
  annotations: [],
  parts: [{ kind: 'text', text: '将衣服改成蓝色' }],
}
const job = (over: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({
    metadata: { frame: 1, shot: 1 },
    sourceUrl: BASE,
    kind: 'image',
    status: 'pending',
    createdAt: '2026-09-07T12:00:00Z',
    request: { prompt: '将衣服改成蓝色', referenceImageUrls: [BASE] },
    ...over,
  })

function EditorPage({ initialKey }: { initialKey?: string }) {
  const [open, setOpen] = useState(true)
  const [frames, setFrames] = useState([BASE, FRAME_2])
  return (
    <>
      {open && (
        <FrameImageEditor
          target={target}
          frames={frames}
          aspectRatio="9:16"
          initialKey={initialKey}
          onClose={() => setOpen(false)}
          onApply={async (_previous, url) => setFrames([url, FRAME_2])}
        />
      )}
      <Toaster />
    </>
  )
}

const UPLOADED = 'https://example.com/uploaded.png'
const imageFile = () => new File(['image'], '参考.png', { type: 'image/png' })

/** 卡在确认那一步的参考图上传；调用返回的开关才放行。 */
function stallUpload() {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  server.use(
    http.post('*/api/uploads/:uploadId/confirm', async () => {
      await held
      return HttpResponse.json({ contentType: 'image/png', sizeBytes: 5, url: UPLOADED })
    }),
  )
  return () => release()
}

/** jsdom 不加载图片也不排版：给底图固有尺寸、给画布外框，返回可以落笔的画布。 */
function loadCanvas(editor: HTMLElement) {
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      readonly pointerId = 1
    },
  )
  const image = within(editor).getByRole('img', { name: '当前编辑帧' })
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 800 } })
  fireEvent.load(image)
  const canvas = within(editor).getByRole('group', { name: '图片标注画布' })
  Object.assign(canvas, {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  return canvas
}

/** 会话读到之前输入卡不收文件；等它按 uploads:write 挂上文件选择框。 */
const waitForUploadPermission = (editor: HTMLElement) =>
  waitFor(() => expect(editor.querySelector('input[type="file"]')).not.toBeNull())

/** 在画布中央点一个点标注。 */
function drawPoint(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, button: 0 })
  fireEvent.pointerUp(canvas, { clientX: 400, clientY: 400, button: 0 })
}

describe('图片编辑器', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ close: vi.fn(), height: 1200, width: 800 }),
    )
    sessionStorage.clear()
    sessionStorage.setItem(editDraftKey(target), JSON.stringify({ [BASE]: draft }))
  })
  afterEach(() => {
    // Toaster 是模块级单例，上一条用例弹出的提示不清掉会串进下一条。
    toast.dismiss()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('生成设置里可以切换渠道，换成没有渠道轴的模型后提交不再携带渠道', async () => {
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage />)

    const models = await screen.findByRole('button', { name: '图片模型' })
    const generate = screen.getByRole('button', { name: '生成图片' })
    expect(screen.queryByRole('menuitemradio', { name: 'pro' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: '更多生成设置' }))
    const channels = await screen.findByRole('group', { name: '图片生成渠道' })
    expect(within(channels).getByRole('menuitemradio', { name: 'dev' })).toBeChecked()
    await userEvent.click(within(channels).getByRole('menuitemradio', { name: 'pro' }))
    await userEvent.click(generate)
    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]?.['channel']).toBe('pro')

    await waitFor(() => expect(models).toBeEnabled())
    await userEvent.click(models)
    // 菜单按模型名称列出，提交的是模型 id。
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Seedream 5.0 Pro' }))
    expect(models).toHaveTextContent('Seedream 5.0 Pro')

    expect(screen.queryByRole('button', { name: '更多生成设置' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '图片分辨率' }))
    const resolutionMenu = await screen.findByRole('menu', { name: '图片分辨率' })
    const resolutions = within(resolutionMenu).getAllByRole('menuitemradio')
    expect(resolutions.map((option) => option.textContent)).toEqual(['1K', '2K'])
    await userEvent.keyboard('{Escape}')

    await userEvent.click(generate)
    await waitFor(() => expect(submissions).toHaveLength(2))
    expect(submissions[1]?.['model']).toBe('seedream_v5_pro')
    expect(submissions[1]?.['channel']).toBeUndefined()
    expect(submissions[1]?.['sourceUrl']).toBe(BASE)
    expect(submissions[1]?.['metadata']).toEqual({ frame: 1, shot: 1 })
  })

  it('做不了分镜画幅的模型在菜单里置灰并标不支持', async () => {
    server.use(
      http.get('*/api/generations/image-models', () =>
        HttpResponse.json({
          default: 'nano_banana_pro',
          items: [
            {
              model: 'nano_banana_pro',
              label: 'Nano Banana Pro',
              aspectRatios: ['9:16'],
              resolutions: ['1k', '2k'],
              channels: [],
            },
            {
              model: 'square_only',
              label: 'Square Only',
              aspectRatios: ['1:1'],
              resolutions: ['1k'],
              channels: [],
            },
          ],
        }),
      ),
    )
    await renderWithProviders(<EditorPage />)

    const models = await screen.findByRole('button', { name: '图片模型' })
    await waitFor(() => expect(models).toBeEnabled())
    await userEvent.click(models)
    const menu = await screen.findByRole('menu', { name: '图片模型' })
    expect(within(menu).getByRole('menuitemradio', { name: 'Nano Banana Pro' })).toBeChecked()
    const unsupported = within(menu).getByRole('menuitemradio', { name: /^Square Only/ })
    expect(unsupported).toHaveAccessibleName(/不支持/)
    expect(unsupported).toHaveAttribute('aria-disabled', 'true')
  })

  it('提交后新任务占一格并自动选中，输入不清空；草稿暂存与记录刷新都失败也不挡着看在途任务', async () => {
    const completed = job({ status: 'completed', outputUrl: RESULT })
    const pending = job()
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return reads === 1
          ? HttpResponse.json({ items: [completed] })
          : HttpResponse.json({ detail: '记录刷新失败' }, { status: 503 })
      }),
      http.post('*/api/generations/image', () =>
        HttpResponse.json({ generation: pending }, { status: 202 }),
      ),
    )
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    await within(strip).findByRole('button', { name: /^结果 · / })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })
    const textbox = within(editor).getByRole('textbox', { name: '修改要求' })
    pasteTextIntoComposer(textbox, '，领口不变')
    expect(await screen.findByText('编辑草稿无法暂存，关闭页面前请先提交生成')).toBeVisible()

    await userEvent.click(within(editor).getByRole('button', { name: '生成图片' }))

    const queued = await within(strip).findByRole('button', { name: /^排队中 · / })
    expect(textbox).toHaveTextContent('将衣服改成蓝色，领口不变')
    expect(queued).toHaveAttribute('aria-pressed', 'true')
    expect(await within(editor).findByRole('status')).toBeVisible()
    expect(await within(editor).findByText(/记录刷新失败/)).toBeVisible()
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
  })

  it('从帧上的新结果进来就选中它，应用之后窗口留着且那张成了当前帧', async () => {
    const completed = job({ status: 'completed', outputUrl: RESULT })
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })))
    await renderWithProviders(<EditorPage initialKey={completed.id} />)

    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    await waitFor(() =>
      expect(within(strip).getByRole('button', { name: /^结果 · / })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(within(editor).getByRole('img', { name: '图片编辑结果' })).toHaveAttribute('src', RESULT)

    const apply = within(editor).getByRole('button', { name: '应用到当前帧' })
    expect(apply).toBeEnabled()
    await userEvent.click(apply)

    expect(await screen.findByText('已应用到当前帧')).toBeVisible()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    // 折进当前帧格之后不再是一张「还没应用」的结果。
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
    expect(within(strip).queryByRole('button', { name: /^结果 · / })).not.toBeInTheDocument()
    // 被换下来的那张留在条里，选中它就能换回去。
    const previous = within(strip).getByRole('button', { name: /^上一版 · / })
    await userEvent.click(previous)
    expect(within(editor).getByRole('button', { name: '应用到当前帧' })).toBeEnabled()
  })

  it('点选中的结果图放大看；Esc 只关预览，编辑器留着，焦点回到结果图', async () => {
    const completed = job({ status: 'completed', outputUrl: RESULT })
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })))
    await renderWithProviders(<EditorPage initialKey={completed.id} />)

    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    const result = await within(editor).findByRole('button', { name: '预览图片编辑结果' })
    await userEvent.click(result)

    const lightbox = await screen.findByRole('dialog', { name: '图片编辑结果' })
    expect(within(lightbox).getByRole('img', { name: '图片编辑结果' })).toHaveAttribute(
      'src',
      RESULT,
    )

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '图片编辑结果' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: /^编辑图片/ })).toBeInTheDocument()
    await waitFor(() => expect(result).toHaveFocus())
  })

  it.each(['pending', 'submitted'] as const)('任务处于 %s 时仍能提交新的编辑', async (status) => {
    const existing = job({ status })
    const submitted = job({ createdAt: '2026-09-07T12:01:00Z' })
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.get('*/api/generations', () =>
        HttpResponse.json({ items: submissions.length === 0 ? [existing] : [submitted, existing] }),
      ),
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: submitted }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage initialKey={existing.id} />)

    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    const selected = await within(strip).findByRole('button', { name: /^(排队中|生成中) · / })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(within(editor).getByRole('status')).toBeVisible()
    expect(within(editor).getByRole('img', { name: '本次编辑底图' })).toHaveAttribute('src', BASE)
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
    const generate = within(editor).getByRole('button', { name: '生成图片' })
    await waitFor(() => expect(generate).toBeEnabled())

    await userEvent.click(generate)

    await waitFor(() => expect(submissions).toHaveLength(1))
    await waitFor(() =>
      expect(within(strip).getAllByRole('button', { name: /^(排队中|生成中) · / })).toHaveLength(2),
    )
    expect(selected).toHaveAttribute('aria-pressed', 'false')
    const next = within(strip)
      .getAllByRole('button', { name: /^排队中 · / })
      .find((button) => button !== selected)
    expect(next).toHaveAttribute('aria-pressed', 'true')
  })

  it.each(['图像服务拒绝了请求（400）: {"detail":"invalid reference image"}', null])(
    '失败状态按需展开原始错误，不把详情直接铺在预览区：%s',
    async (errorMessage) => {
      const failed = job({ status: 'failed', errorMessage })
      server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [failed] })))
      await renderWithProviders(<EditorPage initialKey={failed.id} />)

      const editor = await screen.findByRole('dialog')
      const alert = await within(editor).findByRole('alert')
      expect(alert).toBeVisible()
      expect(within(editor).getByRole('img', { name: '本次编辑底图' })).toHaveAttribute('src', BASE)
      expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
      if (errorMessage === null) {
        expect(within(editor).queryByText('查看详情')).not.toBeInTheDocument()
      } else {
        const error = within(editor).getByText(errorMessage)
        expect(error).not.toBeVisible()
        await userEvent.click(within(editor).getByText('查看详情'))
        expect(error).toBeVisible()
        await userEvent.click(within(editor).getByText('查看详情'))
        expect(error).not.toBeVisible()
      }
      await userEvent.click(within(editor).getByRole('button', { name: '返回当前帧' }))
      const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
      expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    },
  )

  it('上传不锁窗口：传着也能换底图、关窗；没传完的图不进草稿', async () => {
    loginAs(mockAuthUser)
    const completed = job({ status: 'completed', outputUrl: RESULT })
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })))
    const release = stallUpload()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    await waitForUploadPermission(editor)
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    const result = await within(strip).findByRole('button', { name: /^结果 · / })
    const textbox = () => within(editor).getByRole('textbox', { name: '修改要求' })

    pasteFilesIntoComposer(textbox(), [imageFile()])
    expect(within(textbox()).getByText('参考.png')).toBeInTheDocument()
    expect(result).toBeEnabled()
    await userEvent.click(result)
    expect(result).toHaveAttribute('aria-pressed', 'true')
    // 结果那张是另一张底图，输入卡换成它的草稿。
    expect(within(textbox()).queryByText('参考.png')).not.toBeInTheDocument()
    await userEvent.click(within(strip).getByRole('button', { name: '当前帧' }))
    expect(within(textbox()).queryByText('参考.png')).not.toBeInTheDocument()
    expect(textbox()).toHaveTextContent('将衣服改成蓝色')

    pasteFilesIntoComposer(textbox(), [imageFile()])
    await userEvent.click(within(editor).getByRole('button', { name: '关闭图片编辑' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    release()
    expect(JSON.parse(sessionStorage.getItem(editDraftKey(target)) ?? '{}')).toEqual({
      [BASE]: draft,
    })
  })

  it('+ 弹出本组的帧（含 @1），点一下插到光标处；Enter 生成，同一张图只发一次', async () => {
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const textbox = within(editor).getByRole('textbox', { name: '修改要求' })
    await waitFor(() =>
      expect(within(editor).getByRole('button', { name: '图片模型' })).toBeEnabled(),
    )

    // 没有上传权限：「+」照样能插帧，只是没有「从电脑上传」。
    const add = within(editor).getByRole('button', { name: '添加参考图' })
    await userEvent.click(add)
    const popover = await screen.findByRole('dialog', { name: '添加参考图' })
    expect(within(popover).queryByRole('button', { name: '从电脑上传' })).not.toBeInTheDocument()
    await userEvent.click(within(popover).getByRole('button', { name: '插入帧 @2' }))
    expect(screen.queryByRole('dialog', { name: '添加参考图' })).not.toBeInTheDocument()
    expect(within(textbox).getByText('帧 @2')).toBeInTheDocument()
    expect(textbox).toHaveFocus()

    await userEvent.click(add)
    const again = await screen.findByRole('dialog', { name: '添加参考图' })
    // 已引用的帧带勾，再点仍会插入。
    await userEvent.click(within(again).getByRole('button', { name: '插入帧 @2（已引用）' }))
    await userEvent.click(add)
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: '添加参考图' })).getByRole('button', {
        name: '插入帧 @1',
      }),
    )
    expect(within(textbox).getByText('帧 @1 · 编辑底图')).toBeInTheDocument()

    fireEvent.keyDown(textbox, { key: 'Enter' })
    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]).toMatchObject({
      prompt: '将衣服改成蓝色@图片2@图片2@图片1',
      referenceImageUrls: [BASE, FRAME_2],
      sourceUrl: BASE,
    })
  })

  it('@ 引用标注：chip 插在光标处，点它选中画布上的标注；画布上删掉后 chip 失效、提交被拦下', async () => {
    const submissions: unknown[] = []
    server.use(
      http.post('*/api/generations/image', () => {
        submissions.push(true)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    sessionStorage.clear()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const canvas = loadCanvas(editor)
    drawPoint(canvas)
    const textbox = within(editor).getByRole('textbox', { name: '修改要求' })

    pasteTextIntoComposer(textbox, '把')
    act(() => textbox.focus())
    await userEvent.keyboard('@')
    const menu = await screen.findByRole('listbox', { name: '引用图片或标注' })
    expect(
      within(menu)
        .getAllByRole('group')
        .map(
          (group) =>
            group.getAttribute('aria-labelledby') &&
            within(group)
              .getAllByRole('option')
              .map((option) => option.textContent),
        ),
    ).toEqual([['编辑底图'], ['1标注 1'], ['帧 @1', '帧 @2']])
    await userEvent.keyboard('标注{Enter}')
    pasteTextIntoComposer(textbox, '去掉')
    expect(textbox).toHaveTextContent('把1标注 1去掉')

    // 画布上的标注与正文里的 chip 同名，按是否在正文里区分。
    const mark = within(editor)
      .getAllByRole('button', { name: '标注 1' })
      .find((element) => !textbox.contains(element))
    // 在正文里打字时画布上没有选中的标注；点 chip 把它选上。
    expect(mark).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(within(textbox).getByRole('button', { name: '标注 1' }))
    expect(mark).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(within(editor).getByRole('button', { name: '删除此标注' }))
    expect(within(textbox).getByText('标注 1 已删除')).toBeInTheDocument()
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(
      await within(editor).findByText('修改要求中有已删除的标注，请处理失效引用'),
    ).toBeVisible()
    expect(submissions).toHaveLength(0)
  })

  it('图片到上限：+ 里没引用过的帧置灰，再贴图片不收并在卡内提示', async () => {
    loginAs(mockAuthUser)
    const nine = Array.from({ length: 9 }, (_, index) => ({
      kind: 'image' as const,
      name: `图${index}.png`,
      url: `https://example.com/${index}.png`,
    }))
    sessionStorage.setItem(
      editDraftKey(target),
      JSON.stringify({ [BASE]: { annotations: [], parts: [...draft.parts, ...nine] } }),
    )
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    await waitForUploadPermission(editor)
    const textbox = within(editor).getByRole('textbox', { name: '修改要求' })
    expect(within(textbox).getByText('图8.png')).toBeInTheDocument()

    await userEvent.click(within(editor).getByRole('button', { name: '添加参考图' }))
    const popover = await screen.findByRole('dialog', { name: '添加参考图' })
    expect(within(popover).getByRole('button', { name: '插入帧 @2' })).toBeDisabled()
    // 帧 @1 就是底图，不另占一张。
    expect(within(popover).getByRole('button', { name: '插入帧 @1' })).toBeEnabled()
    expect(within(popover).getByRole('button', { name: '从电脑上传' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    pasteFilesIntoComposer(textbox, [imageFile()])
    expect(within(textbox).queryByText('参考.png')).not.toBeInTheDocument()
    expect(within(editor).getByText('最多引用 10 张图片，这次有 1 张没有添加')).toBeVisible()
  })

  it('拖进输入卡就地上传，事件带着 defaultPrevented 冒到 window 供聊天遮罩收尾', async () => {
    loginAs(mockAuthUser)
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    await waitForUploadPermission(editor)
    const zone = within(editor).getByRole('button', { name: '生成图片' })

    // 聊天输入框的遮罩挂在 window 上，靠这三个事件冒泡回来才关得掉。
    const seen: { type: string; prevented: boolean }[] = []
    const record = (event: Event) =>
      seen.push({ type: event.type, prevented: event.defaultPrevented })
    for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, record)

    const file = imageFile()
    const dataTransfer = {
      dropEffect: '',
      files: [file],
      items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => null }],
      types: ['Files'],
    }
    fireEvent.dragEnter(zone, { dataTransfer })
    fireEvent.dragOver(zone, { dataTransfer })
    // 弹窗对文件一律标「禁止落点」，但输入卡先接管了，它的「复制」不能被弹窗改掉。
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(within(editor).getByTestId('composer-drop-overlay')).toBeInTheDocument()
    fireEvent.drop(zone, { dataTransfer })
    for (const type of ['dragenter', 'dragover', 'drop']) window.removeEventListener(type, record)

    expect(seen).toEqual([
      { type: 'dragenter', prevented: true },
      { type: 'dragover', prevented: true },
      { type: 'drop', prevented: true },
    ])
    const textbox = within(editor).getByRole('textbox', { name: '修改要求' })
    expect(within(textbox).getByText('参考.png')).toBeInTheDocument()
  })

  it('弹窗里输入卡以外的地方对文件一律禁止，也不放给背后的聊天框', async () => {
    loginAs(mockAuthUser)
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')

    const dataTransfer = { dropEffect: '', files: [imageFile()], items: [], types: ['Files'] }
    const stage = within(editor).getByRole('img', { name: '当前编辑帧' })
    fireEvent.dragOver(stage, { dataTransfer })
    const drop = createEvent.drop(stage, { dataTransfer })
    fireEvent(stage, drop)

    expect(dataTransfer.dropEffect).toBe('none')
    expect(drop.defaultPrevented).toBe(true)
    expect(within(editor).queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
    expect(screen.queryByText('参考.png')).not.toBeInTheDocument()
  })

  it('从历史菜单恢复输入后回到底图，再次提交保留那次的要求和参考图片', async () => {
    const references = [BASE, 'https://example.com/reference.png']
    const prompt = '保留人物，背景参考@图片2换成傍晚的暖光'
    const completed = job({
      status: 'completed',
      outputUrl: RESULT,
      request: { prompt, referenceImageUrls: references },
    })
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })),
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage initialKey={completed.id} />)

    const editor = await screen.findByRole('dialog')
    await within(editor).findByRole('img', { name: '图片编辑结果' })
    expect(screen.queryByRole('menuitem', { name: '恢复这次的输入' })).not.toBeInTheDocument()
    await userEvent.click(within(editor).getByRole('button', { name: '图片历史操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '恢复这次的输入' }))

    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const textbox = within(editor).getByRole('textbox', { name: '修改要求' })
    expect(textbox).toHaveTextContent('保留人物，背景参考reference.png换成傍晚的暖光')
    await userEvent.click(within(editor).getByRole('button', { name: '生成图片' }))
    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]).toMatchObject({
      prompt,
      referenceImageUrls: references,
      sourceUrl: BASE,
    })
  })

  it('空草稿上画一个标注再撤销，重做仍可用并能画回来', async () => {
    // 撤销到空时草稿被删，之后每次渲染拿到的都是新的空数组；画布的撤销栈不能因此被清掉。
    sessionStorage.clear()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    drawPoint(loadCanvas(editor))
    expect(within(editor).getByRole('button', { name: '标注 1' })).toBeInTheDocument()

    await userEvent.click(within(editor).getByRole('button', { name: '撤销标注' }))
    expect(within(editor).queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    const redo = within(editor).getByRole('button', { name: '重做标注' })
    expect(redo).toBeEnabled()
    await userEvent.click(redo)

    expect(within(editor).getByRole('button', { name: '标注 1' })).toBeInTheDocument()
  })

  it('草稿读坏后点重新开始，画过的标注连同撤销记录一起作废', async () => {
    sessionStorage.setItem(editDraftKey(target), JSON.stringify({ [BASE]: { annotations: 1 } }))
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    drawPoint(loadCanvas(editor))
    expect(within(editor).getByRole('button', { name: '标注 1' })).toBeInTheDocument()

    await userEvent.click(within(editor).getByRole('button', { name: '重新开始' }))
    loadCanvas(editor)

    expect(within(editor).queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: '撤销标注' })).toBeDisabled()
  })
})
