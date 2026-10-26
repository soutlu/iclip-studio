import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { timeLabel } from '../editing/time-label'
import { FADER_MAX, FADER_MIN, faderToGain, gainText, gainToFader, stepGain } from './volume-fader'

type ToolProps = {
  icon: IconName
  label: string
  /** 悬停或键盘聚焦时在按钮上方的说明；写明快捷键 */
  tip: ReactNode
  /** 不能用的原因；给了就置灰、悬停说原因 */
  blocked?: string | undefined
  pressed?: boolean
  onClick: () => void
  showLabel?: boolean
  shortcuts?: string
  className?: string
}

function Tool({
  icon,
  label,
  tip,
  blocked,
  pressed,
  onClick,
  showLabel = false,
  shortcuts,
  className,
}: ToolProps) {
  // 置灰时提示换成原因；点按也亮出原因（同 BlockedReason），按钮本身不重挂，焦点不丢
  const [hint, setHint] = useState(false)
  return (
    <TooltipRoot onOpenChange={setHint} open={hint}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          if (blocked === undefined) return
          event.preventDefault()
          setHint(true)
        }}
      >
        <button
          aria-disabled={blocked === undefined ? undefined : true}
          aria-keyshortcuts={shortcuts}
          aria-label={showLabel ? undefined : label}
          aria-pressed={pressed}
          className={cn(
            'wf-tool ui-state ui-focus',
            showLabel && 'has-label',
            pressed === true && 'is-pressed',
            className,
          )}
          onClick={() => {
            if (blocked === undefined) onClick()
          }}
          type="button"
        >
          <Icon decorative name={icon} size="sm" />
          {showLabel ? <span>{label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {blocked ?? tip}
      </TooltipContent>
    </TooltipRoot>
  )
}

const Keys = ({ children }: { children: string }) => <kbd className="wf-kbd">{children}</kbd>

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
  beatBlocked: string | undefined
  onBeatSync: () => void
  onZoom: (direction: 'in' | 'out') => void
  onFit: () => void
  /** 选中那段视频的原声音量；没选中视频时为 undefined，推子置灰并悬停说 clipBlocked */
  clipVolume: number | undefined
  clipBlocked: string
  onClipVolume: (value: number) => void
  /** 配乐音量；没有选用音乐时为 undefined */
  musicVolume: number | undefined
  onMusicVolume: (value: number) => void
}

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
  beatBlocked,
  onBeatSync,
  onZoom,
  onFit,
  clipVolume,
  clipBlocked,
  onClipVolume,
  musicVolume,
  onMusicVolume,
}: EditorToolbarProps) {
  const playLabel = playing ? '暂停' : '播放'
  return (
    <div aria-label="剪辑工具" className="wf-toolbar" role="toolbar">
      <div className="wf-toolbar-group">
        <Tool
          blocked={playBlocked}
          className="wf-play"
          icon={playing ? 'pause' : 'play'}
          label={playLabel}
          onClick={onPlay}
          shortcuts="Space"
          tip={
            <>
              {playLabel}
              <Keys>空格</Keys>
            </>
          }
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
          shortcuts="Meta+Z"
          tip={
            <>
              撤销
              <Keys>⌘Z</Keys>
            </>
          }
        />
        <Tool
          blocked={canRedo ? undefined : '没有可重做的操作'}
          icon="redo"
          label="重做"
          onClick={onRedo}
          shortcuts="Shift+Meta+Z"
          tip={
            <>
              重做
              <Keys>⇧⌘Z</Keys>
            </>
          }
        />
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          blocked={splitBlocked}
          icon="split"
          label="拆分"
          onClick={onSplit}
          showLabel
          tip="在播放头处拆开"
        />
        <Tool
          blocked={deleteBlocked}
          icon="delete"
          label="删除"
          onClick={onDelete}
          shortcuts="Delete Backspace"
          showLabel
          tip={
            <>
              删除选中的片段
              <Keys>⌫</Keys>
            </>
          }
        />
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          icon="snap"
          label="吸附"
          onClick={onSnap}
          pressed={snap}
          showLabel
          tip="拖动时吸附到拍点、播放头和片段边界"
        />
        <Tool
          blocked={beatBlocked}
          icon="waveform"
          label="自动卡点"
          onClick={onBeatSync}
          showLabel
          tip="把切点挪到最近的拍点上，音乐不动"
        />
      </div>
      <div aria-label="声音" className="wf-toolbar-group wf-toolbar-sound" role="group">
        <VolumeFader
          blocked={clipVolume === undefined ? clipBlocked : undefined}
          label="原声"
          onCommit={onClipVolume}
          value={clipVolume ?? 1}
        />
        <VolumeFader
          blocked={musicVolume === undefined ? '还没有选用音乐' : undefined}
          label="配乐"
          onCommit={onMusicVolume}
          value={musicVolume ?? 1}
        />
        <span aria-hidden="true" className="wf-divider" />
      </div>
      <div className="wf-toolbar-group">
        <Tool icon="zoom-out" label="缩小时间线" onClick={() => onZoom('out')} tip="缩小时间线" />
        <Tool icon="zoom" label="放大时间线" onClick={() => onZoom('in')} tip="放大时间线" />
        <Tool icon="fit" label="适应宽度" onClick={onFit} tip="适应宽度" />
      </div>
    </div>
  )
}

type VolumeFaderProps = {
  label: string
  /** 倍数，0–+12 dB */
  value: number
  blocked?: string | undefined
  onCommit: (value: number) => void
}

/**
 * 音量推子（同 HyperFrames）：按 dB 刻度，0 dB 在正中，最左静音、最右 +12 dB；左边的按钮静音或取消静音。
 * 拖动中只改显示，松手（或失焦）才记一步编辑；双击回到 0 dB，←/→ 每次 0.5 dB，按住 ⇧ 3 dB。
 */
function VolumeFader({ label, value, blocked, onCommit }: VolumeFaderProps) {
  const [live, setLive] = useState<number | null>(null)
  // 取消静音时回到静音前的音量；不记在草稿里，关掉编辑器就忘
  const [beforeMute, setBeforeMute] = useState(1)
  const shown = live ?? value
  const disabled = blocked !== undefined
  const commit = (gain: number) => {
    setLive(null)
    if (gain !== value) onCommit(gain)
  }
  const step = (event: KeyboardEvent<HTMLInputElement>) => {
    const sign = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (sign === 0) return
    event.preventDefault()
    commit(stepGain(shown, sign * (event.shiftKey ? 3 : 0.5)))
  }
  const muted = shown === 0
  return (
    <div className={cn('wf-volume', disabled && 'is-blocked')} title={blocked}>
      <button
        aria-label={muted ? `取消静音${label}` : `静音${label}`}
        className="wf-mute ui-state ui-focus"
        disabled={disabled}
        onClick={() => {
          if (muted) commit(beforeMute)
          else {
            setBeforeMute(shown)
            commit(0)
          }
        }}
        type="button"
      >
        <Icon decorative name={muted ? 'audio-off' : 'audio'} size="sm" />
      </button>
      <label className="wf-volume-label">
        <span>{label}</span>
        <span className="wf-fader">
          <input
            aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
            aria-valuetext={gainText(shown)}
            disabled={disabled}
            max={FADER_MAX}
            min={FADER_MIN}
            onBlur={() => {
              if (live !== null) commit(live)
            }}
            onChange={(event) => setLive(faderToGain(Number(event.target.value)))}
            onDoubleClick={() => commit(1)}
            onKeyDown={step}
            onPointerUp={() => {
              if (live !== null) commit(live)
            }}
            step={0.1}
            title="双击回到 0 dB"
            type="range"
            value={gainToFader(shown)}
          />
          <i aria-hidden="true" className="wf-fader-unity" />
        </span>
      </label>
      <output className="wf-volume-value">{gainText(shown)}</output>
    </div>
  )
}
