import { useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { BlockedReason } from '../components/blocked-reason'
import { timeLabel } from '../editing/time-label'
import { MAX_FILM_MS, MAX_VOLUME } from './editing/draft'

type ToolProps = {
  icon: IconName
  label: string
  /** 不能用的原因；给了就置灰、悬停说原因 */
  blocked?: string | undefined
  pressed?: boolean
  onClick: () => void
  showLabel?: boolean
}

function Tool({ icon, label, blocked, pressed, onClick, showLabel = false }: ToolProps) {
  return (
    <BlockedReason reason={blocked}>
      <button
        aria-disabled={blocked === undefined ? undefined : true}
        aria-label={showLabel ? undefined : label}
        aria-pressed={pressed}
        className={cn(
          'wf-tool ui-state ui-focus',
          showLabel && 'has-label',
          pressed === true && 'is-pressed',
        )}
        onClick={() => {
          if (blocked === undefined) onClick()
        }}
        title={showLabel || blocked !== undefined ? undefined : label}
        type="button"
      >
        <Icon decorative name={icon} size="sm" />
        {showLabel ? <span>{label}</span> : null}
      </button>
    </BlockedReason>
  )
}

type EditorToolbarProps = {
  playheadMs: number
  totalMs: number
  /** 预览放不了的原因 */
  playBlocked: string | undefined
  playing: boolean
  onPlay: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  splitBlocked: string | undefined
  onSplit: () => void
  deleteBlocked: string | undefined
  onDelete: () => void
  snap: boolean
  onSnap: () => void
  onZoom: (direction: 'in' | 'out') => void
  onFit: () => void
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

export function EditorToolbar({
  playheadMs,
  totalMs,
  playBlocked,
  playing,
  onPlay,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  splitBlocked,
  onSplit,
  deleteBlocked,
  onDelete,
  snap,
  onSnap,
  onZoom,
  onFit,
}: EditorToolbarProps) {
  return (
    <div aria-label="剪辑工具" className="wf-toolbar" role="toolbar">
      <div className="wf-toolbar-group">
        <Tool
          blocked={playBlocked}
          icon={playing ? 'pause' : 'play'}
          label={playing ? '暂停' : '播放'}
          onClick={onPlay}
        />
        <span className="wf-clock">
          {timeLabel(playheadMs / 1000)} <span>/ {timeLabel(totalMs / 1000)}</span>
        </span>
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          blocked={canUndo ? undefined : '没有可撤销的操作'}
          icon="undo"
          label="撤销"
          onClick={onUndo}
        />
        <Tool
          blocked={canRedo ? undefined : '没有可重做的操作'}
          icon="redo"
          label="重做"
          onClick={onRedo}
        />
        <span aria-hidden="true" className="wf-divider" />
        <Tool blocked={splitBlocked} icon="split" label="拆分" onClick={onSplit} showLabel />
        <Tool blocked={deleteBlocked} icon="delete" label="删除" onClick={onDelete} showLabel />
        <Tool icon="snap" label="吸附" onClick={onSnap} pressed={snap} showLabel />
      </div>
      <div className="wf-toolbar-group">
        <span className="wf-readout">
          共 <b>{seconds(totalMs)}</b> 秒 · 上限 {MAX_FILM_MS / 1000} 秒
        </span>
        <Tool icon="zoom-out" label="缩小时间线" onClick={() => onZoom('out')} />
        <Tool icon="zoom" label="放大时间线" onClick={() => onZoom('in')} />
        <Tool icon="fit" label="适应宽度" onClick={onFit} />
      </div>
    </div>
  )
}

type VolumeSliderProps = {
  label: string
  /** 倍数，0–2 */
  value: number
  blocked?: string | undefined
  onCommit: (value: number) => void
}

/** 拖动中只改显示，松手（或按键抬起、失焦）才记一步编辑 */
export function VolumeSlider({ label, value, blocked, onCommit }: VolumeSliderProps) {
  const [live, setLive] = useState<number | null>(null)
  const shown = live ?? value
  const commit = () => {
    if (live !== null && live !== value) onCommit(live)
    setLive(null)
  }
  const percent = Math.round(shown * 100)
  return (
    <label className={cn('wf-volume', blocked !== undefined && 'is-blocked')} title={blocked}>
      <Icon decorative name={percent === 0 ? 'audio-off' : 'audio'} size="sm" />
      <span>{label}</span>
      <input
        aria-valuetext={`${percent}%`}
        disabled={blocked !== undefined}
        max={MAX_VOLUME * 100}
        min={0}
        onBlur={commit}
        onChange={(event) => setLive(Number(event.target.value) / 100)}
        onKeyUp={commit}
        onPointerUp={commit}
        step={1}
        type="range"
        value={percent}
      />
      <output>{percent}%</output>
    </label>
  )
}

type SoundRowProps = {
  clipText: string
  clipVolume: number | undefined
  onClipVolume: (value: number) => void
  musicVolume: number | undefined
  onMusicVolume: (value: number) => void
  beatBlocked: string | undefined
  onBeatSync: () => void
}

export function SoundRow({
  clipText,
  clipVolume,
  onClipVolume,
  musicVolume,
  onMusicVolume,
  beatBlocked,
  onBeatSync,
}: SoundRowProps) {
  return (
    <div className="wf-sound">
      <span className="wf-sound-clip">{clipText}</span>
      <VolumeSlider
        blocked={clipVolume === undefined ? '先在成片轨上选中一段视频' : undefined}
        label="原声音量"
        onCommit={onClipVolume}
        value={clipVolume ?? 1}
      />
      <VolumeSlider
        blocked={musicVolume === undefined ? '还没有选用音乐' : undefined}
        label="配乐音量"
        onCommit={onMusicVolume}
        value={musicVolume ?? 1}
      />
      <BlockedReason reason={beatBlocked}>
        <Button
          aria-disabled={beatBlocked === undefined ? undefined : true}
          onClick={() => {
            if (beatBlocked === undefined) onBeatSync()
          }}
          size="md"
          variant="outlined"
        >
          自动卡点
        </Button>
      </BlockedReason>
    </div>
  )
}
