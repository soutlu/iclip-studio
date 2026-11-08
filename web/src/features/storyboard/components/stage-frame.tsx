import type { Ref } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { FrameCounter, type FrameGallery } from './frame-counter'

type StageFrameProps = {
  frame: { name: string; url: string } | undefined
  uploading: boolean
  onOpen: () => void
  openRef: Ref<HTMLButtonElement>
  emptyText?: string
}

export function StageFrame({
  emptyText = '该段暂无图片',
  frame,
  onOpen,
  openRef,
  uploading,
}: StageFrameProps) {
  return (
    <>
      {frame === undefined ? null : (
        <img alt="" className="storyboard-backdrop" draggable={false} src={frame.url} />
      )}
      <div className="storyboard-hero">
        {frame === undefined ? (
          <div className="storyboard-media">
            <p className="storyboard-stage-empty">{emptyText}</p>
          </div>
        ) : (
          <div aria-label="当前帧图片" className="storyboard-media" role="group">
            <button
              aria-label="打开原图"
              className="absolute inset-0 cursor-zoom-in ui-focus"
              onClick={onOpen}
              ref={openRef}
              type="button"
            >
              <img
                alt={frame.name}
                className="size-full object-contain"
                draggable={false}
                src={frame.url}
              />
            </button>
            {uploading ? (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-scrim/32 text-body-sm text-on-scrim"
                role="status"
              >
                <Icon className="animate-spin" decorative name="loading" size="md" />
                正在上传…
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}

type StageFrameNavProps = {
  counter: { aspectRatio: string; gallery: FrameGallery } | undefined
  hasPrevious: boolean
  hasNext: boolean
  onStep: (step: -1 | 1) => void
}

export function StageFrameNav({ counter, hasNext, hasPrevious, onStep }: StageFrameNavProps) {
  return (
    <>
      {hasPrevious ? (
        <IconButton
          className="storyboard-stage-glass storyboard-stage-nav rounded-full"
          data-side="previous"
          label="上一帧"
          name="back"
          onClick={() => onStep(-1)}
          size="lg"
        />
      ) : null}
      {hasNext ? (
        <IconButton
          className="storyboard-stage-glass storyboard-stage-nav rounded-full"
          data-side="next"
          label="下一帧"
          name="next"
          onClick={() => onStep(1)}
          size="lg"
        />
      ) : null}
      {counter === undefined || counter.gallery.urls.length === 0 ? null : (
        <FrameCounter aspectRatio={counter.aspectRatio} gallery={counter.gallery} />
      )}
    </>
  )
}
