import { Slider } from 'radix-ui'
import { useState } from 'react'
import { Icon } from '@/shared/icons'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { timeLabel } from '../editing/time-label'
import { Keys, Tool } from './editor-toolbar'
import type { PlaybackSettings } from './preview-player'

type PreviewTransportProps = {
  playheadMs: number
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
  /** 提示、菜单和面板挂到哪个元素里；全屏时是全屏的元素，不然是 `null`（挂到 body）。 */
  layer: HTMLElement | null
}

// 方向键每次走这么多，按住 Shift 是它的十倍；和编辑器里不在进度条上时的方向键一致
const STEP_SECONDS = 0.1

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

const rateLabel = (rate: number) => `${rate}×`

// 逐条对应编辑器里真有的按键：改了按键处理要同步改这里
const SHORTCUTS: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ['空格'], action: '播放或暂停' },
  { keys: ['←', '→'], action: '播放头往前、往后移 0.1 秒' },
  { keys: ['⇧←', '⇧→'], action: '播放头往前、往后移 1 秒' },
  { keys: ['⌘Z'], action: '撤销' },
  { keys: ['⇧⌘Z'], action: '重做' },
  { keys: ['Delete'], action: '删掉选中的块' },
  { keys: ['['], action: '选中播放头左边的块' },
  { keys: [']'], action: '选中播放头右边的块' },
  { keys: ['Z'], action: '缩放到选中的块' },
  { keys: ['Enter'], action: '把选中的镜头加入成片' },
  { keys: ['Esc'], action: '退出全屏、取消选中；都没有时关闭成片编辑' },
  { keys: ['M'], action: '静音或开启声音' },
  { keys: ['⇧L'], action: '打开或关闭循环播放' },
  { keys: ['F'], action: '全屏或退出全屏' },
]

/** 预览下面的播放条：进度条一行；时间、播放键，右边是试听和看的设置。 */
export function PreviewTransport({
  playheadMs,
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
  const total = totalMs / 1000
  const time = Math.min(playheadMs, totalMs) / 1000
  const percent = (seconds: number) => `${(seconds / total) * 100}%`
  const playLabel = playing ? '暂停' : '播放'
  const muteLabel = playback.muted ? '开启声音' : '静音'
  const fullscreenLabel = fullscreen ? '退出全屏' : '全屏'
  return (
    <div aria-label="播放控制" className="wf-transport" role="group">
      <Slider.Root
        className="wf-seek"
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
      <div className="wf-transport-row">
        <span className="wf-clock">
          {timeLabel(time)} <span>/ {timeLabel(total)}</span>
        </span>
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
          tipContainer={layer}
        />
        <div className="wf-transport-tools">
          <Tool
            icon={playback.muted ? 'audio-off' : 'audio'}
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
            icon="loop"
            label="循环播放"
            onClick={onLoop}
            pressed={playback.loop}
            shortcuts="Shift+L"
            tip={
              <>
                {playback.loop ? '循环播放开着：播到结尾从头接着播' : '循环播放关着：播到结尾停下'}
                <Keys>⇧L</Keys>
              </>
            }
            tipContainer={layer}
          />
          <Tool
            blocked={fullscreenBlocked}
            icon={fullscreen ? 'exit-fullscreen' : 'fullscreen'}
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
      {/* 点开后指针还停在按钮上，提示会重新出现、压在向上弹出的菜单底下 */}
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
      <MenuSurface align="end" className="min-w-24" container={layer} side="top">
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
            <button
              aria-label="快捷键"
              className="wf-tool wf-transport-shortcuts ui-state ui-focus"
              type="button"
            >
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
