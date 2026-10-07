/** 制作页的舞台：选了本组的一条成片就放它（与分镜页同一个成片舞台），否则显示这组用到的一张图，点画面看原图。左上写 @N（还没有编号的写它的名字）；左右箭头与焦点在舞台里时的
 * ←/→ 按这组全部图的先后切，不画帧计数。还没有图的写一句「…还没有图」，没挂图的段写「这段没有图」。
 * 列宽随这组的画幅，见 storyboard.css 的布局一节。 */

import { useRef, useState, type CSSProperties } from 'react'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { StageBar } from '../components/stage-bar'
import { StageFrame, StageFrameNav } from '../components/stage-frame'
import { ShotStage, StageShell, type TakeView } from '../components/shot-stage'
import { stepFrame, useStageFrameKeys } from '../components/use-stage-frame-steps'
import type { FilmFrame, FilmGroup } from './film.api'
import { frameTag } from './film-content'

type FilmStageProps = {
  group: FilmGroup
  /** 选中的成片与它的操作；选了就放它，没选显示图。 */
  take: Omit<TakeView, 'kind'> | undefined
  /** 舞台上那张图在 `frames` 里的位置；选中的段没挂图时为 undefined。 */
  frame: number | undefined
  /** 切到第几张。 */
  onStep: (position: number) => void
  onOpen: (frame: FilmFrame & { url: string }) => void
}

export function FilmStage({ frame: position, group, onOpen, onStep, take }: FilmStageProps) {
  const frame = position === undefined ? undefined : group.frames[position - 1]
  const count = group.frames.length
  const openRef = useRef<HTMLButtonElement | null>(null)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  // 舞台上还不收文件：拖进来的接住不收，免得漏给聊天输入框。
  const drop = useFileDropTarget({ blocked: true, onDirectory: () => {}, onFiles: () => {} })
  const onPrevious =
    position === undefined || position <= 1 ? undefined : () => onStep(position - 1)
  const onNext =
    position === undefined || position >= count ? undefined : () => onStep(position + 1)
  const step = (direction: -1 | 1) =>
    stepFrame(
      {
        onNext,
        onPrevious,
        position: position === undefined ? undefined : { count, index: position },
        restFocus: () => openRef.current?.focus(),
      },
      direction,
    )
  useStageFrameKeys(stage, step)
  const url = frame?.url ?? null
  if (take !== undefined)
    return (
      <ShotStage
        aspectRatio={group.aspectRatio}
        drop={drop}
        shotIndex={group.index}
        view={{ kind: 'take', ...take }}
      />
    )
  return (
    <div
      className="storyboard-stage-column"
      style={{ '--storyboard-ar': aspectValueOf(group.aspectRatio) } as CSSProperties}
    >
      <StageShell
        drop={drop}
        overlay={
          <>
            <StageBar
              end={null}
              start={
                frame === undefined ? null : (
                  <p className="storyboard-stage-glass storyboard-stage-tag">{frameTag(frame)}</p>
                )
              }
            />
            <StageFrameNav
              counter={undefined}
              hasNext={onNext !== undefined}
              hasPrevious={onPrevious !== undefined}
              onStep={step}
            />
          </>
        }
        stageRef={setStage}
      >
        <StageFrame
          emptyText={
            frame === undefined
              ? '这段没有图'
              : // 名字以数字或字母结尾（「镜头 2」）时空一格再接中文。
                `${frame.label}${/\w$/.test(frame.label) ? ' ' : ''}还没有图`
          }
          frame={url === null || frame === undefined ? undefined : { name: frame.label, url }}
          onOpen={() => {
            if (frame !== undefined && url !== null) onOpen({ ...frame, url })
          }}
          openRef={openRef}
          uploading={false}
        />
      </StageShell>
    </div>
  )
}
