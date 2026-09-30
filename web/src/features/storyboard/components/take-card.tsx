/** 成片区的一张卡：整张是一个按钮，点了在舞台上看这条成片，选中时 `aria-pressed` 并加中性描边。
 * 成功卡铺封面，在途卡转圈走表，失败卡只有错误图标；画面上只有角标：左上分辨率、左下编辑次数、右下片长，各自缺了就不画。 */

import { Icon } from '@/shared/icons'
import { formatShortTime } from '@/shared/lib/date-time'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatDuration } from '@/shared/ui/media-preview'
import type { Take } from '../takes'
import { useTakeElapsed } from './use-take-elapsed'

/** 封面截帧宽度：横屏卡最宽三百来像素，两倍屏也够；固定一档，卡宽变了不重新请求。 */
const POSTER_WIDTH = 640

const STATE_TEXT = { completed: '', failed: '，生成失败', running: '，生成中' } as const

type TakeCardProps = {
  take: Take
  size: { width: number; height: number }
  /** 下方时间按它算今天、昨天。 */
  now: Date
  /** 舞台正在看这一条。 */
  selected: boolean
  onSelect: () => void
}

export function TakeCard({ now, onSelect, selected, size, take }: TakeCardProps) {
  const { job } = take
  const time = formatShortTime(job.createdAt, now)
  return (
    <li className="storyboard-take-item">
      <button
        aria-label={`${time} 的成片${STATE_TEXT[take.state]}`}
        aria-pressed={selected}
        className="storyboard-take ui-focus"
        data-state={take.state}
        onClick={onSelect}
        style={{ height: size.height, width: size.width }}
        type="button"
      >
        {take.state === 'running' ? (
          <RunningFace since={job.createdAt} />
        ) : take.state === 'failed' ? (
          <span className="storyboard-take-center text-error">
            <Icon decorative name="alert" size="md" />
          </span>
        ) : (
          <CompletedFace url={take.outputUrl} />
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
      </button>
      <time className="storyboard-take-time" dateTime={job.createdAt}>
        {time}
      </time>
    </li>
  )
}

function CompletedFace({ url }: { url: string | undefined }) {
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
      {/* 遮罩照样压：角标是浅色字，没有封面时也要一层深底才读得清。 */}
      <span className="storyboard-take-veil" />
    </>
  )
}

/** 在途卡：扫光加转圈与已用时长。 */
function RunningFace({ since }: { since: string }) {
  const elapsed = useTakeElapsed(since)
  return (
    <>
      <span className="storyboard-take-shine" />
      <span className="storyboard-take-center">
        <Icon className="animate-spin" decorative name="spinner" size="md" />
        {elapsed}
      </span>
    </>
  )
}
