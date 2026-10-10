/** 舞台显示选中的成片，按这条成片自己的画幅 contain：出了片就用共享播放器自动播（点卡片即用户手势，带声音；不循环，停在末帧），
 * 在途是按画幅的骨架加转圈与已用时长，失败是错误图标加完整原因。换一条或切走就卸载，播放随之停止。 */

import type { CSSProperties } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { VideoPlayer } from '@/shared/ui/video-player'
import type { Take } from '../takes'
import { useElapsed } from '@/shared/ui/media-preview'

/** 舞台上的封面截帧宽度：宽屏舞台六七百像素，两倍屏也够。 */
const POSTER_WIDTH = 1280

export function StageTake({ take }: { take: Take }) {
  return (
    <div
      className="storyboard-hero"
      style={{ '--storyboard-ar': take.aspect.w / take.aspect.h } as CSSProperties}
    >
      {take.outputUrl !== undefined ? (
        <VideoPlayer
          autoPlay
          className="absolute inset-0"
          label="生成的视频"
          poster={videoSnapshotUrl(take.outputUrl, POSTER_WIDTH)}
          src={take.outputUrl}
        />
      ) : take.state === 'running' ? (
        <RunningTake since={take.job.createdAt} />
      ) : (
        <div className="storyboard-take-stage" role="alert">
          <Icon className="text-error" decorative name="alert" size="lg" />
          <p className="storyboard-take-stage-reason">
            {take.error ?? (take.state === 'failed' ? '未返回失败原因' : '未返回视频地址')}
          </p>
        </div>
      )}
    </div>
  )
}

function RunningTake({ since }: { since: string }) {
  const elapsed = useElapsed(since)
  return (
    <div aria-label={`生成中，已用 ${elapsed}`} className="storyboard-take-stage" role="status">
      <span className="storyboard-take-shine" />
      <Icon className="animate-spin" decorative name="spinner" size="lg" />
      <span className="tabular-nums">{elapsed}</span>
    </div>
  )
}
