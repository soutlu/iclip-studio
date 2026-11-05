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

export type StageReplace = {
  drop: ReturnType<typeof useFileDropTarget>
  onPaste: (event: ClipboardEvent<HTMLElement>) => void
  replace: (file: File) => Promise<void>
  uploading: boolean
}

type FilmStageProps = {
  group: FilmGroup
  take: Omit<TakeView, 'kind'> | undefined
  frame: number | undefined
  readOnly: boolean
  replace: StageReplace
  generate: {
    job: GenerationJob | undefined
    busy: GenerateCardBusy
    error: string | undefined
    onGenerate: () => void
    onChoose: (url: string) => void
  }
  edit: {
    openable: boolean
    badge: FrameBadge | undefined
    onEdit: (open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
  }
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
