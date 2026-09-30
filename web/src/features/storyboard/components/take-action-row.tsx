/** 舞台显示成片时下方的操作行：左边分辨率 · 时长 · 生成时间（模型 id 在提示里），右边下载、编辑视频、回填提示词。
 * 各动作出不出现、能不能用由 `takeActionsOf` 定，这里只照着画。 */

import { useState } from 'react'
import { formatShortTime } from '@/shared/lib/date-time'
import { formatDuration } from '@/shared/ui/media-preview'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import type { Take, TakeActions } from '../takes'
import { StageAction } from './stage-action'
import { useCollapsedTextHint } from './use-collapsed-text-hint'
import { STAGE_ACTION_TEXT, stageActionClass } from './workbench-control'

type TakeActionRowProps = {
  take: Take
  actions: TakeActions
  onEditVideo: () => void
  onRefill: () => void
}

export function TakeActionRow({ actions, onEditVideo, onRefill, take }: TakeActionRowProps) {
  const { download, editVideo, refill } = actions
  // 「今天」「昨天」按挂上那一刻算；换一条成片会重挂。
  const [now] = useState(() => new Date())
  // 下载与 StageAction 同一条提示规则：带字时不重复名字，退成图标才提示。
  const { bindText: bindDownloadText, tooltip: downloadTooltip } = useCollapsedTextHint()
  const model = take.model ?? '未记录模型'
  const info = [
    take.resolution,
    take.durationSeconds === undefined ? undefined : formatDuration(take.durationSeconds),
    formatShortTime(take.job.createdAt, now),
  ].filter((item) => item !== undefined && item !== '')
  return (
    <div className="storyboard-actions" data-kind="take">
      <div className="storyboard-actions-start">
        <TooltipRoot>
          <TooltipTrigger asChild>
            <p className="storyboard-take-info">
              {info.join(' · ')}
              {/* 模型 id 悬停才露；读屏直接念出来。 */}
              <span className="sr-only">，{model}</span>
            </p>
          </TooltipTrigger>
          <TooltipContent className="font-mono">{model}</TooltipContent>
        </TooltipRoot>
      </div>
      <div className="storyboard-actions-end">
        {download.kind === 'enabled' && take.outputUrl !== undefined ? (
          <VideoDownload
            className={stageActionClass}
            jobId={take.job.id}
            tooltip={downloadTooltip}
            url={take.outputUrl}
            watermarkUrl={take.job.watermarkOutputUrl}
          >
            <span className={STAGE_ACTION_TEXT} ref={bindDownloadText}>
              下载
            </span>
          </VideoDownload>
        ) : download.kind === 'blocked' ? (
          <StageAction blocker={download.reason} icon="download" label="下载视频" text="下载" />
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
      </div>
    </div>
  )
}
