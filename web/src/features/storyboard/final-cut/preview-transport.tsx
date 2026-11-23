import { Slider } from 'radix-ui'
import { useState } from 'react'
import { Icon } from '@/shared/icons'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { timeLabel } from '../editing/time-label'
import { Keys, Tool } from './editor-toolbar'
import { usePlayheadClock, type PlayheadClock } from './playhead-clock'
import type { PlaybackSettings } from './preview-player'

type PreviewTransportProps = {
  /** 播放头实时时钟源：进度条与时间读数独立订阅，实现播放期间逐帧更新而不触发整个播放条重绘。 */
  clock: PlayheadClock
  totalMs: number
  buffered: readonly TimeSpan[]
  playBlocked: string | undefined
  playing: boolean
  onPlay: () => void
  onSeek: (ms: number) => void
  playback: PlaybackSettings
  onMute: () => void
  onRate: (rate: number) => void
  onLoop: () => void
  fullscreen: boolean
  fullscreenBlocked: string | undefined
  onFullscreen: () => void
  /** 提示、菜单与面板的挂载容器；全屏时为全屏宿主元素，非全屏为 `null`（挂载至 `document.body`）。 */
  layer: HTMLElement | null
}

// 方向键默认单步时长，按住 Shift 为 10 倍，与编辑器全局键盘步进保持一致
const STEP_SECONDS = 0.1

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

const rateLabel = (rate: number) => `${rate}×`

// 与编辑器实际注册的快捷键逐条对应，修改快捷键逻辑时须同步更新此列表
const SHORTCUTS: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ['空格'], action: '播放或暂停' },
  { keys: ['←', '→'], action: '播放头前移或后移 0.1 秒' },
  { keys: ['⇧←', '⇧→'], action: '播放头前移或后移 1 秒' },
  { keys: ['⌘Z'], action: '撤销' },
  { keys: ['⇧⌘Z'], action: '重做' },
  { keys: ['Delete'], action: '删除选中的片段' },
  { keys: ['['], action: '选中播放头左边的片段' },
  { keys: [']'], action: '选中播放头右边的片段' },
  { keys: ['S'], action: '在播放头处切开选中的片段' },
  { keys: ['B'], action: '切换切开工具和选择工具' },
  { keys: ['⇧⌘B'], action: '分离选中视频的音频，或合并回视频' },
  { keys: ['V', 'A'], action: '回到选择工具' },
  { keys: ['Z'], action: '缩放到选中的片段' },
  { keys: ['Enter'], action: '将选中的镜头加入轨道' },
  { keys: ['Esc'], action: '退出全屏、取消选中、回到选择工具' },
  { keys: ['M'], action: '静音或开启声音' },
  { keys: ['⇧L'], action: '开启或关闭循环播放' },
  { keys: ['F'], action: '全屏或退出全屏' },
]

/** 预览区底部播放控制条：上方为进度条，下方左侧为播放/暂停键与时间读数，右侧为音量、倍速、循环、全屏与快捷键入口。 */
export function PreviewTransport({
  clock,
  totalMs,
  buffered,
  playBlocked,
  playing,
  onPlay,
  onSeek,
  playback,
  onMute,
  onRate,
  onLoop,
  fullscreen,
  fullscreenBlocked,
  onFullscreen,
  layer,
}: PreviewTransportProps) {
  const playLabel = playing ? '暂停' : '播放'
  const muteLabel = playback.muted ? '开启声音' : '静音'
  const fullscreenLabel = fullscreen ? '退出全屏' : '全屏'
  return (
    <div aria-label="播放控制" className="wf-transport" role="group">
      <SeekBar buffered={buffered} clock={clock} onSeek={onSeek} totalMs={totalMs} />
      <div className="wf-transport-row">
        <div className="wf-transport-play">
          <Tool
            blocked={playBlocked}
            className="wf-play"
            icon={playing ? 'final-cut-pause' : 'final-cut-play'}
            label={playLabel}
            onClick={onPlay}
            shortcuts="Space"
            tip={
              <>
                {playLabel}
                <Keys>空格</Keys>
              </>
            }
            tipContainer={layer}
          />
          <ClockReading clock={clock} totalMs={totalMs} />
        </div>
        <div className="wf-transport-tools">
          <Tool
            icon={playback.muted ? 'final-cut-sound-off' : 'final-cut-sound-on'}
            label={muteLabel}
            onClick={onMute}
            shortcuts="M"
            tip={
              <>
                {muteLabel}
                <Keys>M</Keys>
              </>
            }
            tipContainer={layer}
          />
          <RateMenu layer={layer} onRate={onRate} rate={playback.rate} />
          <Tool
            icon="final-cut-loop"
            label="循环播放"
            onClick={onLoop}
            pressed={playback.loop}
            shortcuts="Shift+L"
            tip={
              <>
                {playback.loop
                  ? '循环播放已开启：播放到结尾后从头继续'
                  : '循环播放已关闭：播放到结尾后停止'}
                <Keys>⇧L</Keys>
              </>
            }
            tipContainer={layer}
          />
          <Tool
            blocked={fullscreenBlocked}
            icon={fullscreen ? 'exit-fullscreen' : 'final-cut-fullscreen'}
            label={fullscreenLabel}
            onClick={onFullscreen}
            shortcuts="F"
            tip={
              <>
                {fullscreenLabel}
                <Keys>F</Keys>
              </>
            }
            tipContainer={layer}
          />
          <ShortcutsPanel layer={layer} />
        </div>
      </div>
    </div>
  )
}

type ClockProps = { clock: PlayheadClock; totalMs: number }

/** 播放进度条：订阅播放头实时时钟，播放期间逐帧推进。 */
function SeekBar({
  clock,
  totalMs,
  buffered,
  onSeek,
}: ClockProps & { buffered: readonly TimeSpan[]; onSeek: (ms: number) => void }) {
  const total = totalMs / 1000
  const time = Math.min(usePlayheadClock(clock), totalMs) / 1000
  const percent = (seconds: number) => `${(seconds / total) * 100}%`
  return (
    <Slider.Root
      className="wf-seek"
      data-testid="preview-seek"
      disabled={total <= 0}
      max={total > 0 ? total : 1}
      onValueChange={([at]) => {
        if (at !== undefined) onSeek(Math.round(at * 1000))
      }}
      step={STEP_SECONDS}
      value={[time]}
    >
      <Slider.Track className="wf-seek-track">
        {total > 0
          ? buffered.map(({ start, end }) => (
              <span
                aria-hidden="true"
                className="wf-seek-buffered"
                data-testid="preview-buffered"
                key={start}
                style={{ left: percent(start), width: percent(Math.min(end, total) - start) }}
              />
            ))
          : null}
        <Slider.Range className="wf-seek-range" />
      </Slider.Track>
      <Slider.Thumb
        aria-label="播放进度"
        aria-valuetext={`${timeLabel(time)} / ${timeLabel(total)}`}
        className="wf-seek-thumb ui-focus"
      />
    </Slider.Root>
  )
}

/** 播放时间读数：订阅播放头实时时钟，播放期间逐帧刷新。 */
function ClockReading({ clock, totalMs }: ClockProps) {
  const time = Math.min(usePlayheadClock(clock), totalMs) / 1000
  return (
    <span className="wf-clock">
      {timeLabel(time)} <span>/ {timeLabel(totalMs / 1000)}</span>
    </span>
  )
}

function RateMenu({
  rate,
  onRate,
  layer,
}: {
  rate: number
  onRate: (rate: number) => void
  layer: HTMLElement | null
}) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  return (
    <MenuRoot
      onOpenChange={(next) => {
        setOpen(next)
        setHint(false)
      }}
      open={open}
    >
      {/* 菜单展开时若指针仍停留在按钮上，抑制 Tooltip 避免压在向上弹出的菜单下方 */}
      <TooltipRoot onOpenChange={setHint} open={hint && !open}>
        <MenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              aria-label={`播放速度 ${rateLabel(rate)}`}
              className="wf-tool wf-rate ui-state ui-focus"
              type="button"
            >
              {rateLabel(rate)}
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" container={layer} side="top">
          播放速度
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="end" className="wf-menu min-w-24" container={layer} side="top">
        <MenuRadioGroup onValueChange={(value) => onRate(Number(value))} value={String(rate)}>
          {RATES.map((option) => (
            <MenuRadioItem key={option} value={String(option)}>
              {rateLabel(option)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}

function ShortcutsPanel({ layer }: { layer: HTMLElement | null }) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  return (
    <PopupRoot
      onOpenChange={(next) => {
        setOpen(next)
        setHint(false)
      }}
      open={open}
    >
      <TooltipRoot onOpenChange={setHint} open={hint && !open}>
        <PopupTrigger asChild>
          <TooltipTrigger asChild>
            <button aria-label="快捷键" className="wf-tool ui-state ui-focus" type="button">
              <Icon decorative name="shortcuts" size="sm" />
            </button>
          </TooltipTrigger>
        </PopupTrigger>
        <TooltipContent className="wf-tip" container={layer} side="top">
          快捷键
        </TooltipContent>
      </TooltipRoot>
      <PopupSurface
        align="end"
        aria-label="快捷键"
        className="wf-shortcuts"
        collisionPadding={8}
        container={layer}
        side="top"
        sideOffset={8}
      >
        <p className="wf-shortcuts-title">快捷键</p>
        <dl className="wf-shortcuts-list">
          {SHORTCUTS.map(({ keys, action }) => (
            <div className="wf-shortcuts-row" key={action}>
              <dt>{action}</dt>
              <dd>
                {keys.map((key) => (
                  <kbd className="wf-shortcuts-key" key={key}>
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </PopupSurface>
    </PopupRoot>
  )
}
