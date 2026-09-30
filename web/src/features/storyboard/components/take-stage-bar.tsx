/** 舞台显示成片时右上的工具条：成片信息（ⓘ，分辨率 · 时长 · 生成时间与模型 id 收在提示里）、下载、编辑视频、回填提示词，
 * 一律深色玻璃图标按钮。画面上不挂别的信息胶囊；播放控件是共享播放器自带的底部胶囊，与这里互不遮挡。
 * 各动作出不出现、能不能用由 `takeActionsOf` 定，这里只照着画。 */

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
              jobId={take.job.id}
              url={take.outputUrl}
              watermarkUrl={take.job.watermarkOutputUrl}
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

/** 成片信息按钮：悬停、聚焦或点按弹出「分辨率 · 时长 · 生成时间」与模型 id；可访问名里带着同样的内容，读屏不用等提示。
 * 触屏没有悬停，Radix 提示又不接触摸，所以受控开合、点按也打开，做法同 `BlockedReason`。 */
function TakeInfo({ take }: { take: Take }) {
  // 「今天」「昨天」按挂上那一刻算；换一条成片会重挂。
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
        // 拦下默认处理，Radix 才不会在点按时把提示关掉。
        onClick={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
      >
        <button
          aria-label={`成片信息：${info}，${model}`}
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
