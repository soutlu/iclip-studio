import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { formatShortTime } from '@/shared/lib/date-time'
import { formatDuration } from '@/shared/ui/media-preview'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import type { Take, TakeActions } from '../takes'
import { StageAction } from './stage-action'
import { StageBar } from './stage-bar'
import { stageActionClass } from './workbench-control'

type TakeStageBarProps = {
  take: Take
  actions: TakeActions
  onEditVideo: () => void
  onRefill: () => void
}

export function TakeStageBar({ actions, onEditVideo, onRefill, take }: TakeStageBarProps) {
  const { download, editVideo, refill } = actions
  return (
    <StageBar
      end={
        <>
          <TakeInfo take={take} />
          {download.kind === 'enabled' && take.outputUrl !== undefined ? (
            <VideoDownload
              className={stageActionClass}
              downloadedJobIds={[take.shown.id]}
              durationMs={take.shown.durationMs}
              enhanceSourceId={take.shown.id}
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

function TakeInfo({ take }: { take: Take }) {
  const [now] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const model = take.model ?? '未记录模型'
  const info = [
    take.resolution,
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
