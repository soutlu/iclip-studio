/** 成片区的一张卡：成功卡中间是播放，悬停（触屏常显）露出回填提示词与编辑视频；在途卡转圈并走表，失败卡只有错误图标、原因在悬停里。
 * 画面上的角标：左上分辨率、左下编辑次数、右下片长，各自缺了就不画。卡本身不接点击。 */

import { useEffect, useState } from 'react'
import { Icon } from '@/shared/icons'
import { formatShortTime } from '@/shared/lib/date-time'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatDuration } from '@/shared/ui/media-preview'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { Shot } from '../shot-document'
import type { GenerationJob } from '../storyboard.api'
import type { Take } from '../takes'
import { BlockedReason } from './blocked-reason'
import { workbenchControl } from './workbench-control'

/** 封面截帧宽度：横屏卡最宽三百来像素，两倍屏也够；固定一档，卡宽变了不重新请求。 */
const POSTER_WIDTH = 640

const REFILL_BLOCKED = '这条出片没记分镜结构，回填不了'

type TakeCardProps = {
  take: Take
  size: { width: number; height: number }
  /** 下方时间按它算今天、昨天。 */
  now: Date
  onPlay: (url: string, poster: string | undefined) => void
  /** 只读时不给，剪刀与回填都不出现。 */
  onEditVideo?: ((job: GenerationJob) => void) | undefined
  onRefill?: ((prompt: Shot['prompt']) => void) | undefined
}

export function TakeCard({ now, onEditVideo, onPlay, onRefill, size, take }: TakeCardProps) {
  const { job } = take
  return (
    <li className="storyboard-take-item">
      <div
        className="storyboard-take"
        data-state={take.state}
        style={{ height: size.height, width: size.width }}
      >
        {take.state === 'running' ? (
          <RunningFace since={job.createdAt} />
        ) : take.state === 'failed' ? (
          <FailedFace error={take.error} />
        ) : (
          <CompletedFace model={take.model} onPlay={onPlay} url={take.outputUrl} />
        )}
        {take.resolution === undefined ? null : (
          <span className="storyboard-take-pill storyboard-take-resolution">{take.resolution}</span>
        )}
        {take.editCount > 0 ? (
          <span
            aria-label={`编辑过 ${take.editCount} 次`}
            className="storyboard-take-pill storyboard-take-edits"
            role="img"
          >
            <Icon decorative name="edit-video" size="xs" />
            {take.editCount}
          </span>
        ) : null}
        {take.durationSeconds === undefined ? null : (
          <span className="storyboard-take-pill storyboard-take-duration">
            {formatDuration(take.durationSeconds)}
          </span>
        )}
        {take.outputUrl === undefined ? null : (
          <TakeActions
            history={take.history}
            onEditVideo={onEditVideo === undefined ? undefined : () => onEditVideo(job)}
            onRefill={onRefill}
          />
        )}
      </div>
      <time className="storyboard-take-time" dateTime={job.createdAt}>
        {formatShortTime(job.createdAt, now)}
      </time>
    </li>
  )
}

function CompletedFace({
  model,
  onPlay,
  url,
}: {
  model: string | undefined
  onPlay: TakeCardProps['onPlay']
  url: string | undefined
}) {
  const poster = url === undefined ? undefined : videoSnapshotUrl(url, POSTER_WIDTH)
  return (
    <>
      {poster === undefined ? null : (
        <img
          alt="生成的视频封面"
          className="absolute inset-0 size-full object-contain"
          decoding="async"
          loading="lazy"
          src={poster}
        />
      )}
      {/* 遮罩照样压：播放钮与角标都是浅色字，没有封面时也要一层深底才读得清。 */}
      <span className="storyboard-take-veil" />
      {url === undefined ? null : (
        <TooltipRoot>
          <TooltipTrigger asChild>
            <button
              aria-label="播放视频"
              className="storyboard-take-play ui-focus"
              onClick={() => onPlay(url, poster)}
              type="button"
            >
              <Icon className="fill-current" decorative name="play" size="md" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="font-mono">{model ?? '未记录模型'}</TooltipContent>
        </TooltipRoot>
      )}
    </>
  )
}

/** 在途卡：转圈加已用时长，每秒走一格；两端时钟有偏差时不出负数。
 * 中间这块是播不了的播放位，用置灰按钮铺满整张卡，悬停、聚焦、点按都说为什么（触屏没有悬停）。 */
function RunningFace({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = formatDuration(Math.max(0, (now - Date.parse(since)) / 1000))
  return (
    <>
      <span className="storyboard-take-shine" />
      <BlockedReason reason="还在生成，出片后可编辑">
        <button
          aria-disabled
          aria-label={`生成中，已用 ${elapsed}`}
          className="storyboard-take-center ui-focus"
          type="button"
        >
          <Icon className="animate-spin" decorative name="spinner" size="md" />
          {elapsed}
        </button>
      </BlockedReason>
    </>
  )
}

/** 失败卡：只有错误图标；原因（服务端原话，可能很长）悬停、聚焦或点按时看，做法同在途卡。 */
function FailedFace({ error }: { error: string | undefined }) {
  return (
    <BlockedReason reason={error ?? '没有返回失败原因'}>
      <button
        aria-disabled
        aria-label="生成失败"
        className="storyboard-take-center text-error ui-focus"
        type="button"
      >
        <Icon decorative name="alert" size="md" />
      </button>
    </BlockedReason>
  )
}

/** 右上竖排的两个操作：回填提示词在上、编辑视频在下。没记分镜结构的回填置灰并说原因。 */
function TakeActions({
  history,
  onEditVideo,
  onRefill,
}: {
  history: Shot['prompt'] | undefined
  onEditVideo: (() => void) | undefined
  onRefill: ((prompt: Shot['prompt']) => void) | undefined
}) {
  if (onEditVideo === undefined && onRefill === undefined) return null
  const control = workbenchControl({ shape: 'icon', size: 'sm' })
  return (
    <div className="storyboard-take-actions">
      {onRefill === undefined ? null : (
        <BlockedReason reason={history === undefined ? REFILL_BLOCKED : undefined} side="left">
          <button
            aria-disabled={history === undefined ? true : undefined}
            aria-label="回填提示词"
            className={control}
            onClick={() => {
              if (history !== undefined) onRefill(history)
            }}
            title={history === undefined ? undefined : '回填提示词'}
            type="button"
          >
            <Icon decorative name="undo" size="xs" />
          </button>
        </BlockedReason>
      )}
      {onEditVideo === undefined ? null : (
        <button
          aria-label="编辑视频"
          className={control}
          onClick={onEditVideo}
          title="编辑视频"
          type="button"
        >
          <Icon decorative name="edit-video" size="xs" />
        </button>
      )}
    </div>
  )
}
