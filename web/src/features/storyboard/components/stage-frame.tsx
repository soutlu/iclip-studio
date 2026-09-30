/** 舞台显示分镜帧。画面按分镜画幅 contain，整张画面是「打开原图」按钮；这帧正在替换时压一层「正在上传」。
 * 画面比例与分镜画幅不一致时，空出来的地方铺同一张图的模糊暗版，上下排时舞台两侧也铺满。
 * 舞台上另叠左右切帧箭头与底部正中的帧计数（`StageFrameNav`）：它们与画面按钮是兄弟、叠在它上面，点箭头不开原图；
 * @N、任务角标、上传状态与编辑、替换仍在下面的操作行。位置与显隐见 storyboard.css 的「舞台叠层」一节。 */

import type { MouseEvent, Ref } from 'react'
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
}

export function StageFrame({ frame, onOpen, openRef, uploading }: StageFrameProps) {
  return (
    <>
      {frame === undefined ? null : (
        <img alt="" className="storyboard-backdrop" draggable={false} src={frame.url} />
      )}
      <div className="storyboard-hero">
        {frame === undefined ? (
          <div className="storyboard-media">
            <p className="text-body-sm text-on-surface-faint">这段还没有图</p>
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
  aspectRatio: string
  gallery: FrameGallery
  /** 上一帧、下一帧；到头的一侧不给，那一侧的箭头不出现（不是置灰）。 */
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  /** 把焦点放回画面（「打开原图」按钮）。 */
  restFocus: () => void
}

/** 叠在舞台上的切帧箭头与帧计数。点到头的箭头随即消失：焦点原在它身上时交给画面，键盘用户不会掉回页面开头。 */
export function StageFrameNav({
  aspectRatio,
  gallery,
  onNext,
  onPrevious,
  restFocus,
}: StageFrameNavProps) {
  const { position } = gallery
  const go = (event: MouseEvent<HTMLButtonElement>, step: -1 | 1, move: () => void) => {
    const focused = document.activeElement === event.currentTarget
    move()
    const reachesEnd =
      position !== undefined &&
      (step === 1 ? position.index + 1 === position.count : position.index - 1 === 1)
    if (focused && reachesEnd) restFocus()
  }
  return (
    <>
      {onPrevious === undefined ? null : (
        <IconButton
          className="storyboard-stage-glass storyboard-stage-nav rounded-full"
          data-side="previous"
          label="上一帧"
          name="back"
          onClick={(event) => go(event, -1, onPrevious)}
          size="lg"
        />
      )}
      {onNext === undefined ? null : (
        <IconButton
          className="storyboard-stage-glass storyboard-stage-nav rounded-full"
          data-side="next"
          label="下一帧"
          name="next"
          onClick={(event) => go(event, 1, onNext)}
          size="lg"
        />
      )}
      {gallery.urls.length === 0 ? null : (
        <FrameCounter aspectRatio={aspectRatio} gallery={gallery} />
      )}
    </>
  )
}
