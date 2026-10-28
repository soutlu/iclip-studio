import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readyAttachment, type ComposerPart, type ComposerSubmission } from '@/shared/ui/composer'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { VIDEO_CLIP_MODELS } from '@/testing/video-models'
import { AiEditCard } from './ai-edit-card'
import { clipGenerationBlock } from './clip-generation'

const FIRST_FRAME = 'https://example.com/first-frame.jpg'
const NEXT_FRAME = 'https://example.com/next-frame.jpg'
const REFERENCE = 'https://example.com/reference.jpg'
const wanModel = () => {
  const model = VIDEO_CLIP_MODELS.find((item) => item.id === 'wan3.0-video')
  if (model === undefined) throw new Error('测试模型缺失')
  return model
}
const MODEL = wanModel()

const imagePart = (url: string, name: string): ComposerPart => ({
  kind: 'media',
  media: readyAttachment({ kind: 'image', name, url }),
})

type CardProps = {
  firstFrame?: string
  initialDraft?: readonly ComposerPart[]
  initialMode?: 'image' | 'edit'
  referenceLimit?: number
  onGenerate: (submission: ComposerSubmission) => void
}

function Card({
  firstFrame = FIRST_FRAME,
  initialDraft = [],
  initialMode = 'edit',
  referenceLimit = MODEL.maxReferenceImages,
  onGenerate,
}: CardProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(initialDraft)
  const [mode, setMode] = useState(initialMode)
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div ref={anchorRef} />
      <AiEditCard
        alerts={null}
        anchorRef={anchorRef}
        canGenerate
        detail="00:00.00–00:05.00 · 5 秒"
        draft={draft}
        durationControl={null}
        firstFrameReferenceUrl={firstFrame}
        frames={{ first: firstFrame, last: firstFrame }}
        generating={false}
        generationBlockOf={(referenceImageCount) =>
          clipGenerationBlock(MODEL, { mode, seconds: 5, referenceImageCount })
        }
        mode={mode}
        modelPicker={null}
        onCollapse={() => setOpen(false)}
        onDraftChange={setDraft}
        onExpand={() => setOpen(true)}
        onGenerate={onGenerate}
        onModeChange={setMode}
        onUploadsDropped={() => undefined}
        open={open}
        positions="镜头 1"
        referenceLimit={referenceLimit}
      />
    </div>
  )
}

const editor = () => screen.getByRole('textbox', { name: '修改要求' })
const generate = () => screen.getByRole('button', { name: '生成视频' })

describe('视频编辑卡的生成方式与图片引用', () => {
  it('首帧只出现在 @ 候选，编辑模式的纯文字提交不隐式带图', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    await renderWithProviders(<Card onGenerate={onGenerate} />)

    expect(within(editor()).queryByText('选区首帧')).not.toBeInTheDocument()
    pasteTextIntoComposer(editor(), '让人物向前走')
    await user.click(generate())
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ media: [], parts: [{ kind: 'text', text: '让人物向前走' }] }),
    )

    act(() => editor().focus())
    await user.keyboard('@')
    expect(screen.getByRole('option', { name: '选区首帧' })).toBeVisible()
    expect(within(editor()).queryByText('选区首帧')).not.toBeInTheDocument()
  })

  it('切换方式保留文字和 chip，图生必须引用图片，删除最后一个图片后不能提交', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    await renderWithProviders(<Card onGenerate={onGenerate} />)
    pasteTextIntoComposer(editor(), '保持人物造型，参考 ')
    expect(generate()).toBeEnabled()

    await user.click(screen.getByRole('radio', { name: '图生' }))
    expect(generate()).toBeDisabled()
    expect(editor()).toHaveTextContent('保持人物造型，参考')
    act(() => editor().focus())
    await user.keyboard('@选区首帧{Enter}')
    expect(within(editor()).getByText('选区首帧')).toBeVisible()
    expect(generate()).toBeEnabled()

    await user.click(screen.getByRole('radio', { name: '编辑' }))
    await user.click(screen.getByRole('radio', { name: '图生' }))
    expect(editor()).toHaveTextContent('保持人物造型，参考 选区首帧')
    await user.click(generate())
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ media: [expect.objectContaining({ url: FIRST_FRAME })] }),
    )

    act(() => editor().focus())
    fireEvent.keyDown(editor(), { key: 'Backspace', keyCode: 8 })
    await waitFor(() => expect(within(editor()).queryByText('选区首帧')).not.toBeInTheDocument())
    expect(generate()).toBeDisabled()
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('切换选区更新首帧候选，正文已经引用的图片地址保持不变', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    const view = await renderWithProviders(<Card initialMode="image" onGenerate={onGenerate} />)
    act(() => editor().focus())
    await user.keyboard('@选区首帧{Enter}')
    // 首帧不写进正文，只有它时没有可提交的描述。
    expect(generate()).toBeDisabled()
    pasteTextIntoComposer(editor(), '人物转身')
    expect(generate()).toBeEnabled()

    view.rerender(<Card firstFrame={NEXT_FRAME} initialMode="image" onGenerate={onGenerate} />)
    await user.click(generate())
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ media: [expect.objectContaining({ url: FIRST_FRAME })] }),
    )

    act(() => editor().focus())
    await user.keyboard('@')
    const candidate = screen.getByRole('option', { name: '选区首帧' })
    expect(within(candidate).getByRole('presentation')).toHaveAttribute('src', NEXT_FRAME)
    expect(screen.getByRole('option', { name: '已引用首帧' })).toBeVisible()
    await user.click(candidate)
    await user.click(generate())
    expect(onGenerate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({ url: FIRST_FRAME }),
          expect.objectContaining({ url: NEXT_FRAME }),
        ],
      }),
    )
  })

  it('已上传的参考图可从 @ 重引用，达到上限时相同图片不再占用名额', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    const initialDraft = Array.from({ length: MODEL.maxReferenceImages }, (_, index) =>
      imagePart(
        index === 0 ? REFERENCE : `https://example.com/ref-${index}.jpg`,
        `参考图${index + 1}`,
      ),
    )
    await renderWithProviders(
      <Card initialDraft={initialDraft} initialMode="image" onGenerate={onGenerate} />,
    )
    act(() => editor().focus())
    await user.keyboard('@')

    expect(screen.getByRole('option', { name: /选区首帧/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    const reusable = screen.getByRole('option', { name: '参考图1' })
    expect(reusable).not.toHaveAttribute('aria-disabled')
    await user.click(reusable)
    expect(within(editor()).getAllByText('参考图1')).toHaveLength(2)
    expect(generate()).toBeEnabled()

    await user.keyboard('@')
    expect(screen.getAllByRole('option', { name: '参考图1' })).toHaveLength(1)
    expect(screen.getByRole('option', { name: /选区首帧/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('切到最多 9 图的模型保留已有 10 张图片并阻止生成，删除到 9 张后可提交', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn<(submission: ComposerSubmission) => void>()
    const initialDraft = Array.from({ length: 10 }, (_, index) =>
      imagePart(`https://example.com/ref-${index}.jpg`, `参考图${index + 1}`),
    )
    const view = await renderWithProviders(
      <Card initialDraft={initialDraft} initialMode="image" onGenerate={onGenerate} />,
    )
    expect(generate()).toBeEnabled()

    view.rerender(<Card initialMode="image" onGenerate={onGenerate} referenceLimit={9} />)
    expect(within(editor()).getAllByText(/^参考图\d+$/)).toHaveLength(10)
    expect(screen.getByRole('alert')).toHaveTextContent('最多支持 9 张参考图，已引用 10 张')
    expect(generate()).toBeDisabled()
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onGenerate).not.toHaveBeenCalled()

    act(() => editor().focus())
    fireEvent.keyDown(editor(), { key: 'Backspace', keyCode: 8 })
    await waitFor(() => expect(within(editor()).getAllByText(/^参考图\d+$/)).toHaveLength(9))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(generate()).toBeEnabled()
    await user.click(generate())
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0]?.[0].media.map((image) => image.url)).toEqual(
      Array.from({ length: 9 }, (_, index) => `https://example.com/ref-${index}.jpg`),
    )
  })
})
