/** 舞台显示分镜帧。画面按分镜画幅 contain，整张画面是「打开原图」按钮；这帧正在替换时压一层「正在上传」。
 * 画面比例与分镜画幅不一致时，空出来的地方铺同一张图的模糊暗版，上下排时舞台两侧也铺满。
 * 舞台上另叠左右切帧箭头与底部正中的帧计数（`StageFrameNav`），以及顶部工具条（`FrameStageBar`）：它们与画面按钮是兄弟、
 * 叠在它上面，点它们不开原图；焦点在舞台里时 ←/→ 也切帧，与点箭头走同一个 `stepFrame`（见 `use-stage-frame-steps.ts`）。
 * 位置与显隐见 storyboard.css 的「舞台叠层」一节。 */

import type { Ref } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { FrameCounter, type FrameGallery } from './frame-counter'

type StageFrameProps = {
  /** 当前帧；这段没有帧时为 undefined，舞台留空。 */
  frame: { name: string; url: string } | undefined
  /** 这一帧正在替换。 */
  uploading: boolean
  onOpen: () => void
  /** 「打开原图」按钮；箭头到头隐藏时焦点交给它。 */
  openRef: Ref<HTMLButtonElement>
  /** 没有图时舞台上写的一句。 */
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
  /** 底部正中的帧计数；不给就不画。 */
  counter: { aspectRatio: string; gallery: FrameGallery } | undefined
  /** 哪一侧还能切；到头的一侧箭头不出现（不是置灰）。 */
  hasPrevious: boolean
  hasNext: boolean
  onStep: (step: -1 | 1) => void
}

/** 叠在舞台上的切帧箭头与帧计数；制作页不要帧计数。 */
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
