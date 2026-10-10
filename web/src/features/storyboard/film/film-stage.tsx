/** 制作页的舞台：选了本组的一条成片就放它（与分镜页同一个成片舞台），否则显示这组用到的一张图，点画面看原图。
 * 左上写 @N（还没有编号的写它的名字），有图时下面挂这张图最新图片任务的角标；右上「编辑」（这张图在用或生成过才有）与「替换」；
 * 左右箭头与焦点在舞台里时的 ←/→ 按这组全部图的先后切，不画帧计数。
 * 换图三个入口同一条路（`useFilmReplace`）：「替换」选文件、拖到舞台上、点过舞台后粘贴；没图的那张也能换。
 * 还没有图的生成图是生成卡（`FilmGenerateCard`），没挂图的段写「该段暂无图片」。列宽随这组的画幅，见 storyboard.css 的布局一节。 */

import { useRef, useState, type ClipboardEvent, type CSSProperties } from 'react'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import type { useFileDropTarget } from '@/shared/ui/file-drop'
import { ShotStage, StageShell, type TakeView } from '../components/shot-stage'
import { FrameBadgeMark } from '../components/frame-stage-bar'
import { StageAction } from '../components/stage-action'
import { StageBar } from '../components/stage-bar'
import { StageFrame, StageFrameNav } from '../components/stage-frame'
import { stepFrame, useStageFrameKeys } from '../components/use-stage-frame-steps'
import type { FrameBadge } from '../frame-status'
import type { GenerationJob } from '../storyboard.api'
import type { FilmGroup } from './film.api'
import { frameTag, missingImageText } from './film-content'
import { FilmGenerateCard, type GenerateCardBusy } from './film-generate-card'
import { FILM_EDIT_TRIGGER } from './film-image-edit'

/** 换图要的：拖放区、粘贴、选文件，以及舞台上这张是不是正在换。 */
export type StageReplace = {
  drop: ReturnType<typeof useFileDropTarget>
  onPaste: (event: ClipboardEvent<HTMLElement>) => void
  replace: (file: File) => Promise<void>
  uploading: boolean
}

type FilmStageProps = {
  group: FilmGroup
  /** 选中的成片与它的操作；选了就放它，没选显示图。 */
  take: Omit<TakeView, 'kind'> | undefined
  /** 舞台上那张图在 `frames` 里的位置；选中的段没挂图时为 undefined。 */
  frame: number | undefined
  readOnly: boolean
  replace: StageReplace
  /** 还没有图的那张：它最近一次生成的任务、正在提交的那件事、提交失败的原话，与「生成这张」「选用这张」。 */
  generate: {
    job: GenerationJob | undefined
    busy: GenerateCardBusy
    error: string | undefined
    onGenerate: () => void
    onChoose: (url: string) => void
  }
  /** 编辑入口：能不能打开（这张图在用，或生成过），有图时这张图最新那条图片任务的角标，与打开编辑器
   * （先看底图，或从角标进先看那条结果）。 */
  edit: {
    openable: boolean
    badge: FrameBadge | undefined
    onEdit: (open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
  }
  /** 切到第几张。 */
  onStep: (position: number) => void
  onOpen: (media: { name: string; url: string }) => void
}

export function FilmStage({
  edit,
  frame: position,
  generate,
  group,
  onOpen,
  onStep,
  readOnly,
  replace,
  take,
}: FilmStageProps) {
  const frame = position === undefined ? undefined : group.frames[position - 1]
  const count = group.frames.length
  const openRef = useRef<HTMLButtonElement | null>(null)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
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
  if (take !== undefined)
    return (
      <ShotStage
        aspectRatio={group.aspectRatio}
        drop={replace.drop}
        shotIndex={group.index}
        view={{ kind: 'take', ...take }}
      />
    )
  const url = frame?.url ?? null
  return (
    <div
      className="storyboard-stage-column"
      style={{ '--storyboard-ar': aspectValueOf(group.aspectRatio) } as CSSProperties}
    >
      <StageShell
        drop={replace.drop}
        onPaste={replace.onPaste}
        overlay={
          <>
            <StageBar
              end={
                frame === undefined || readOnly ? null : (
                  <>
                    {!edit.openable ? null : (
                      <StageAction
                        {...{ [FILM_EDIT_TRIGGER]: '' }}
                        disabled={replace.uploading}
                        icon="edit-image"
                        label="编辑图片"
                        onClick={() => edit.onEdit({ kind: 'draft' })}
                        text="编辑"
                      />
                    )}
                    <ReplaceAction
                      locked={replace.uploading}
                      onFile={(file) => void replace.replace(file)}
                    />
                  </>
                )
              }
              start={
                frame === undefined ? null : (
                  <>
                    <p className="storyboard-stage-glass storyboard-stage-tag">{frameTag(frame)}</p>
                    {url === null || edit.badge === undefined ? null : (
                      <FrameBadgeMark
                        badge={edit.badge}
                        disabled={readOnly || replace.uploading}
                        onOpenResult={(jobId) => edit.onEdit({ jobId, kind: 'result' })}
                      />
                    )}
                  </>
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
        {frame !== undefined && url === null && frame.kind === 'generated' ? (
          <FilmGenerateCard
            busy={generate.busy}
            error={generate.error}
            frame={frame}
            job={generate.job}
            onChoose={generate.onChoose}
            onEnlarge={(image, name) => onOpen({ name, url: image })}
            onGenerate={generate.onGenerate}
            readOnly={readOnly}
          />
        ) : (
          <StageFrame
            emptyText={frame === undefined ? '该段暂无图片' : missingImageText(frame.label)}
            frame={url === null || frame === undefined ? undefined : { name: frame.label, url }}
            onOpen={() => {
              if (frame !== undefined && url !== null) onOpen({ name: frame.label, url })
            }}
            openRef={openRef}
            uploading={replace.uploading}
          />
        )}
      </StageShell>
    </div>
  )
}

/** 「替换」：选一个图片文件换掉舞台上这张。 */
function ReplaceAction({ locked, onFile }: { locked: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <StageAction
        disabled={locked}
        icon="image"
        label="替换图片"
        onClick={() => inputRef.current?.click()}
        text="替换"
      />
      <input
        accept={MEDIA_IMAGE_ACCEPT}
        aria-label="选择替换图片"
        className="hidden"
        disabled={locked}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) onFile(file)
        }}
        ref={inputRef}
        type="file"
      />
    </>
  )
}
