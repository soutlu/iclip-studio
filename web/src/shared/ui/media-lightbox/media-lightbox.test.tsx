import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { type LightboxMedia, MediaLightbox } from './media-lightbox'

const photo: LightboxMedia = {
  kind: 'image',
  name: '商品 1 图片 2',
  url: 'https://example.com/a.png',
}

/** 需求单弹窗里点缩略图打开预览的最小复刻。 */
function DialogWithPreview({
  onDialogOpenChange,
}: {
  onDialogOpenChange: (open: boolean) => void
}) {
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  return (
    <DialogRoot open onOpenChange={onDialogOpenChange}>
      <DialogSurface aria-describedby={undefined}>
        <DialogHeader closeLabel="关闭" title="需求单详情" />
        <button onClick={() => setPreview(photo)} type="button">
          预览商品 1 图片 2
        </button>
        <MediaLightbox media={preview} onClose={() => setPreview(null)} />
      </DialogSurface>
    </DialogRoot>
  )
}

describe('MediaLightbox', () => {
  it('在弹窗里打开：挂到宿主弹窗之后，Esc 只关预览，焦点回到打开它的按钮', async () => {
    const onDialogOpenChange = vi.fn()
    render(<DialogWithPreview onDialogOpenChange={onDialogOpenChange} />)
    const host = screen.getByRole('dialog', { name: '需求单详情' })
    const trigger = screen.getByRole('button', { name: '预览商品 1 图片 2' })

    await userEvent.click(trigger)
    const lightbox = await screen.findByRole('dialog', { name: photo.name })
    // 同一 z 层靠 DOM 顺序盖住宿主，所以必须排在宿主之后。
    expect(host.compareDocumentPosition(lightbox) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: photo.name })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '需求单详情' })).toBeInTheDocument()
    expect(onDialogOpenChange).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('点暗区关闭预览，宿主弹窗不受影响', async () => {
    const onDialogOpenChange = vi.fn()
    render(<DialogWithPreview onDialogOpenChange={onDialogOpenChange} />)
    await userEvent.click(screen.getByRole('button', { name: '预览商品 1 图片 2' }))
    await screen.findByRole('dialog', { name: photo.name })

    await userEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(screen.queryByRole('dialog', { name: photo.name })).not.toBeInTheDocument()
    expect(onDialogOpenChange).not.toHaveBeenCalled()
  })

  it('视频用共享播放器自动播放：从给定秒数起播，焦点落在播放器上，关掉时带回播到的秒数', async () => {
    const onClose = vi.fn()
    render(
      <MediaLightbox
        media={{ kind: 'video', name: '生成的视频', startAt: 2, url: 'https://example.com/a.mp4' }}
        onClose={onClose}
      />,
    )
    const video = screen.getByLabelText<HTMLVideoElement>('生成的视频', { selector: 'video' })
    expect(video).toHaveAttribute('src', 'https://example.com/a.mp4')
    expect(video).toHaveAttribute('autoplay')
    expect(video.controls).toBe(false)
    // 焦点给播放器，空格等快捷键直接可用；灯箱里不再有放大
    expect(screen.getByRole('group', { name: '播放器：生成的视频' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '放大' })).not.toBeInTheDocument()

    fireEvent.loadedMetadata(video)
    expect(video.currentTime).toBe(2)
    video.currentTime = 7
    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledExactlyOnceWith(7)
  })
})
