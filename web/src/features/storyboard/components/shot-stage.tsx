import {
  useRef,
  useState,
  type ClipboardEventHandler,
  type CSSProperties,
  type ReactNode,
} from 'react'
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

export type FrameView = {
  kind: 'frame'
  frame: StageFrameInfo | undefined
  disabled: boolean
  gallery: FrameGallery
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  replacing: boolean
  onReplaceFile: (file: File) => void
  onOpenFrame: (frame: StageFrameInfo) => void
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
}

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
  drop: ReturnType<typeof useFileDropTarget>
  view: FrameView | TakeView
}

export function ShotStage({ aspectRatio, drop, shotIndex, view }: ShotStageProps) {
  return (
    <div
      className="storyboard-stage-column"
      style={{ '--storyboard-ar': aspectValueOf(aspectRatio) } as CSSProperties}
    >
      {view.kind === 'frame' ? (
        <FrameStage aspectRatio={aspectRatio} drop={drop} shotIndex={shotIndex} view={view} />
      ) : (
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
            counter={{ aspectRatio, gallery: view.gallery }}
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

export function StageShell({
  children,
  drop,
  onPaste,
  overlay,
  stageRef,
}: {
  children: ReactNode
  drop: ShotStageProps['drop']
  onPaste?: ClipboardEventHandler<HTMLDivElement> | undefined
  overlay?: ReactNode
  stageRef?: ((node: HTMLDivElement | null) => void) | undefined
}) {
  return (
    <div
      className="storyboard-stage"
      onPaste={onPaste}
      ref={stageRef}
      tabIndex={onPaste === undefined ? undefined : -1}
      {...drop.dragHandlers}
    >
      <div className="storyboard-stage-content animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none">
        {children}
      </div>
      {overlay}
      {drop.dragOver ? (
        <div aria-hidden className="storyboard-drop bg-glass-surface">
          <span className="storyboard-drop-hint">
            <Icon decorative name="image" size="md" />
            松开可替换当前图片
          </span>
        </div>
      ) : null}
    </div>
  )
}
