/** 舞台列：上面是舞台，只放画面或视频（外加拖放提示），下面一条固定高的操作行。按选中的是帧还是成片二选一，
 * 两种各自一套舞台内容与操作行；换了显示的东西舞台内容淡入。整块舞台是替换当前帧的拖放区，显示成片时锁定。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import type { useFileDropTarget } from '@/shared/ui/file-drop'
import type { Take, TakeActions } from '../takes'
import type { FrameUpload } from '../use-frame-additions'
import { FrameActionRow, type StageFrameInfo } from './frame-action-row'
import type { FrameGallery } from './frame-counter'
import { StageFrame } from './stage-frame'
import { StageTake } from './stage-take'
import { TakeActionRow } from './take-action-row'

/** 舞台显示分镜帧。 */
export type FrameView = {
  kind: 'frame'
  /** 当前段没有帧时为 undefined，舞台留空。 */
  frame: StageFrameInfo | undefined
  disabled: boolean
  gallery: FrameGallery
  /** 上一帧、下一帧；到头的一侧不给，按钮置灰。 */
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  /** 往选中段添加新图（粘贴、选择器上传）的进度与失败重试，来自 `useFrameAdditions`。 */
  addition: { upload: FrameUpload; onRetry: () => void }
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
  /** 替换当前帧的拖放区；显示成片时由 `useFrameReplacement` 锁定，不亮提示。 */
  drop: ReturnType<typeof useFileDropTarget>
  view: FrameView | TakeView
}

export function ShotStage({ aspectRatio, drop, shotIndex, view }: ShotStageProps) {
  return (
    <div className="storyboard-stage-column">
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
  return (
    <>
      <StageShell drop={drop}>
        <StageFrame
          aspectRatio={aspectRatio}
          frame={
            frame === undefined
              ? undefined
              : { name: `镜头组 ${shotIndex} 第 ${frame.number} 帧`, url: frame.url }
          }
          onOpen={() => {
            if (frame !== undefined) view.onOpenFrame(frame)
          }}
          uploading={view.replacing}
        />
      </StageShell>
      <FrameActionRow
        addition={view.addition}
        aspectRatio={aspectRatio}
        disabled={view.disabled}
        frame={frame}
        gallery={view.gallery}
        onEditFrame={view.onEditFrame}
        onNext={view.onNext}
        onPrevious={view.onPrevious}
        onReplaceFile={view.onReplaceFile}
        replacing={view.replacing}
      />
    </>
  )
}

function TakeStage({ drop, view }: { drop: ShotStageProps['drop']; view: TakeView }) {
  return (
    <>
      <StageShell drop={drop}>
        <StageTake take={view.take} />
      </StageShell>
      <TakeActionRow
        actions={view.actions}
        onEditVideo={view.onEditVideo}
        onRefill={view.onRefill}
        take={view.take}
      />
    </>
  )
}

/** 舞台底板：中性底色、内容淡入、拖放提示。 */
function StageShell({ children, drop }: { children: ReactNode; drop: ShotStageProps['drop'] }) {
  return (
    <div className="storyboard-stage" {...drop.dragHandlers}>
      <div className="storyboard-stage-content animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none">
        {children}
      </div>
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
