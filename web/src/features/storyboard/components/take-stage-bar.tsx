import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { formatShortTime } from '@/shared/lib/date-time'
import { formatDuration } from '@/shared/ui/media-preview'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import { qualityLabelOf, type FullHdAction, type Take, type TakeActions } from '../takes'
import { StageAction } from './stage-action'
import { StageBar } from './stage-bar'
import { stageActionClass } from './workbench-control'

type TakeStageBarProps = {
  take: Take
  actions: TakeActions
  onEditVideo: () => void
  onRefill: () => void
  onConvertDraft: () => void
  onSelectTake: (jobId: string) => void
}

export function TakeStageBar({
  actions,
  onConvertDraft,
  onEditVideo,
  onRefill,
  onSelectTake,
  take,
}: TakeStageBarProps) {
  const { download, editVideo, fullHd, refill } = actions
  return (
    <StageBar
      end={
        <>
          <FullHdStageAction action={fullHd} onConvert={onConvertDraft} onSelect={onSelectTake} />
          <TakeInfo take={take} />
          {download.kind === 'enabled' && take.outputUrl !== undefined ? (
            <VideoDownload
              className={stageActionClass}
              durationMs={take.shown.durationMs}
              enhanceSourceId={take.shown.id}
              jobId={take.shown.id}
              url={take.outputUrl}
              watermarkUrl={take.shown.watermarkOutputUrl}
            />
          ) : download.kind === 'blocked' ? (
            <StageAction blocker={download.reason} icon="download" label="下载视频" />
          ) : null}
          {editVideo.kind === 'hidden' ? null : (
            <StageAction
              blocker={editVideo.kind === 'blocked' ? editVideo.reason : undefined}
              icon="edit-video"
              label="编辑视频"
              onClick={onEditVideo}
            />
          )}
          {refill.kind === 'hidden' ? null : (
            <StageAction
              blocker={refill.kind === 'blocked' ? refill.reason : undefined}
              icon="undo"
              label="回填提示词"
              onClick={onRefill}
            />
          )}
        </>
      }
    />
  )
}

const CONVERT_TEXT = '转 1080p'

function FullHdStageAction({
  action,
  onConvert,
  onSelect,
}: {
  action: FullHdAction
  onConvert: () => void
  onSelect: (jobId: string) => void
}) {
  switch (action.kind) {
    case 'hidden':
      return null
    case 'convert':
      return (
        <StageAction icon="sparkles" label={CONVERT_TEXT} onClick={onConvert} text={CONVERT_TEXT} />
      )
    case 'converting':
      return (
        <StageAction
          busy
          icon="sparkles"
          label="正在转 1080p"
          onClick={() => onSelect(action.jobId)}
          text={CONVERT_TEXT}
        />
      )
    case 'converted':
      return (
        <StageAction
          icon="preview"
          label="查看 1080p"
          onClick={() => onSelect(action.jobId)}
          text="查看 1080p"
        />
      )
  }
}

function TakeInfo({ take }: { take: Take }) {
  const [now] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const model = take.model ?? '未记录模型'
  const info = [
    qualityLabelOf(take),
    take.durationSeconds === undefined ? undefined : formatDuration(take.durationSeconds),
    formatShortTime(take.job.createdAt, now),
  ]
    .filter((item) => item !== undefined && item !== '')
    .join(' · ')
  return (
    <TooltipRoot onOpenChange={setOpen} open={open}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
      >
        <button
          aria-label={`素材片信息：${info}，${model}`}
          className={stageActionClass}
          type="button"
        >
          <Icon decorative name="info" size="sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent align="end" className="tabular-nums" side="bottom">
        <p>{info}</p>
        <p className="font-mono">{model}</p>
      </TooltipContent>
    </TooltipRoot>
  )
}
