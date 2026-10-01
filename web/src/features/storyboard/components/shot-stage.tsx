/** 舞台列：只有舞台，纵向吃满到出片栏。按选中的是帧还是成片二选一，两种各自一套舞台内容与叠层；换了显示的东西舞台内容淡入。
 * 叠层都在舞台里：顶部工具条（帧：`FrameStageBar`；成片：`TakeStageBar`），显示帧时另有左右切帧箭头与底部的帧计数
 * （`StageFrameNav`），焦点在舞台里时 ←/→ 也切帧；成片舞台不接方向键。
 * 整块舞台是替换当前帧的拖放区，拖放提示盖在所有东西上面；显示成片时锁定。舞台列宽随分镜画幅，见 storyboard.css。 */

import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import type { useFileDropTarget } from '@/shared/ui/file-drop'
import type { Take, TakeActions } from '../takes'
import type { FrameGallery } from './frame-counter'
import { FrameStageBar, type StageFrameInfo } from './frame-stage-bar'
import { StageFrame, StageFrameNav } from './stage-frame'
import { StageTake } from './stage-take'
import { TakeStageBar } from './take-stage-bar'
import { stepFrame, useStageFrameKeys } from './use-stage-frame-steps'

/** 舞台显示分镜帧。 */
export type FrameView = {
  kind: 'frame'
  /** 当前段没有帧时为 undefined，舞台留空。 */
  frame: StageFrameInfo | undefined
  disabled: boolean
  gallery: FrameGallery
  /** 上一帧、下一帧；到头的一侧不给，那一侧的箭头不出现。 */
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  /** 当前帧正在替换，来自 `useFrameReplacement`。 */
  replacing: boolean
  onReplaceFile: (file: File) => void
  onOpenFrame: (frame: StageFrameInfo) => void
  /** 打开这一帧的编辑器；`open` 决定进去先看哪张：编辑按钮进底图，角标进那条新结果。 */
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
}

/** 舞台显示选中的成片。 */
export type TakeView = {
  kind: 'take'
  take: Take
  actions: TakeActions
  onEditVideo: () => void
  onRefill: () => void
}

type ShotStageProps = {
  shotIndex: number
  aspectRatio: string
  /** 替换当前帧的拖放区；显示成片时由 `useFrameReplacement` 锁定，不亮提示，进行中的替换照旧完成。 */
  drop: ReturnType<typeof useFileDropTarget>
  view: FrameView | TakeView
}

export function ShotStage({ aspectRatio, drop, shotIndex, view }: ShotStageProps) {
  return (
    // 分镜画幅挂在舞台列上：列宽按它算，帧画面也按它占位；成片的画面框用自己的画幅另挂。
    <div
      className="storyboard-stage-column"
      style={{ '--storyboard-ar': aspectValueOf(aspectRatio) } as CSSProperties}
    >
      {view.kind === 'frame' ? (
        <FrameStage aspectRatio={aspectRatio} drop={drop} shotIndex={shotIndex} view={view} />
      ) : (
        // 换一条成片就整块重挂：淡入重来一次，播放器跟着卸载。
        <TakeStage drop={drop} key={view.take.job.id} view={view} />
      )}
    </div>
  )
}

function FrameStage({
  aspectRatio,
  drop,
  shotIndex,
  view,
}: Omit<ShotStageProps, 'view'> & { view: FrameView }) {
  const { frame } = view
  const openRef = useRef<HTMLButtonElement | null>(null)
  const step = (direction: -1 | 1) =>
    stepFrame(
      {
        onNext: view.onNext,
        onPrevious: view.onPrevious,
        position: view.gallery.position,
        restFocus: () => openRef.current?.focus(),
      },
      direction,
    )
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  useStageFrameKeys(stage, step)
  return (
    <StageShell
      drop={drop}
      overlay={
        <>
          <FrameStageBar
            disabled={view.disabled}
            frame={frame}
            onEditFrame={view.onEditFrame}
            onReplaceFile={view.onReplaceFile}
            replacing={view.replacing}
          />
          <StageFrameNav
            aspectRatio={aspectRatio}
            gallery={view.gallery}
            hasNext={view.onNext !== undefined}
            hasPrevious={view.onPrevious !== undefined}
            onStep={step}
          />
        </>
      }
      stageRef={setStage}
    >
      <StageFrame
        frame={
          frame === undefined
            ? undefined
            : { name: `镜头组 ${shotIndex} 第 ${frame.number} 帧`, url: frame.url }
        }
        onOpen={() => {
          if (frame !== undefined) view.onOpenFrame(frame)
        }}
        openRef={openRef}
        uploading={view.replacing}
      />
    </StageShell>
  )
}

function TakeStage({ drop, view }: { drop: ShotStageProps['drop']; view: TakeView }) {
  return (
    <StageShell
      drop={drop}
      overlay={
        <TakeStageBar
          actions={view.actions}
          onEditVideo={view.onEditVideo}
          onRefill={view.onRefill}
          take={view.take}
        />
      }
    >
      <StageTake take={view.take} />
    </StageShell>
  )
}

/** 舞台底板：深色放映底、内容淡入、拖放提示。`overlay` 叠在内容上面、不跟着淡入，拖放提示再盖在它上面；
 * 两者都在拖放区里，拖到叠层的按钮上照样算落在舞台上。
 * `stageRef` 交出舞台元素，帧视图在上面挂 ←/→ 切帧。 */
function StageShell({
  children,
  drop,
  overlay,
  stageRef,
}: {
  children: ReactNode
  drop: ShotStageProps['drop']
  overlay?: ReactNode
  stageRef?: (node: HTMLDivElement | null) => void
}) {
  return (
    <div className="storyboard-stage" ref={stageRef} {...drop.dragHandlers}>
      <div className="storyboard-stage-content animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none">
        {children}
      </div>
      {overlay}
      {drop.dragOver ? (
        <div aria-hidden className="storyboard-drop bg-glass-surface">
          <span className="storyboard-drop-hint">
            <Icon decorative name="image" size="md" />
            松开替换当前图片
          </span>
        </div>
      ) : null}
    </div>
  )
}
