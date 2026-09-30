/** 文案列：列头写镜头数与总长，带「收成摘要」开关和按时长切分的镜头条；正文区最上面是全局设定卡，
 * 之后按时间线排各镜头，左侧时间轴在序号节点下标出起始时间，末尾是结束刻度。
 * 默认全文；收成摘要时未选中的镜头只露两行、全局设定三行。点哪段选中哪段，舞台跟着切到它的首帧。
 * 时间一律写一位小数加 s，总长取最后一镜的止秒。版式见 storyboard.css 的「文案列」一节。 */

import {
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { Icon } from '@/shared/icons'
import { Button, IconButton } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  contentLabel,
  formatTimeRange,
  formatTimecode,
  promptLength,
  segmentTimeRange,
  timelineDuration,
  updateContentPrompt,
  type SegmentTime,
  type ShotContent,
} from '../shot-content'
import type { Shot } from '../shot-document'
import { copyWithToast } from './copy-with-toast'
import type { FrameAdd } from './frame-tile'
import { PromptEditor, type PromptEditorHandle } from './prompt-editor'

type ShotScriptProps = {
  shot: Shot
  aspectRatio: string
  /** 正文里 `@` 选图末格的「+」。 */
  add: FrameAdd
  /** 挂在文案列的捕获阶段，接管粘贴进来的图片；只在这里粘贴才添加图片。 */
  onPasteCapture: (event: ClipboardEvent<HTMLElement>) => void
  /** 要排出来的段，见 `scriptSegments`。 */
  segments: readonly ShotContent[]
  /** 选中的段；舞台在看成片时为 undefined，哪段都不标。 */
  selectedId: string | undefined
  /** 选中段里正在看的帧，正文里对应的 @N 高亮。 */
  frameNumber: number | undefined
  readOnly: boolean
  editorRef: (id: string) => Ref<PromptEditorHandle>
  onSelect: (content: string, frame?: number) => void
  onUpdateShot: (updater: (current: Shot) => Shot) => unknown
}

/** 镜头段与它的序号（从 1 起）、时间。 */
type Scene = { segment: ShotContent; number: number; time: SegmentTime }

// 段里自带选中动作的控件（展开全局设定、点缩略图）聚焦时不再走「焦点进段就选中」，免得先选段再选帧跳两次。
const keepFocusInside = (event: FocusEvent) => event.stopPropagation()

export function ShotScript({
  add,
  aspectRatio,
  editorRef,
  frameNumber,
  onPasteCapture,
  onSelect,
  onUpdateShot,
  readOnly,
  segments,
  selectedId,
  shot,
}: ShotScriptProps) {
  const [compact, setCompact] = useState(false)
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const itemsRef = useRef(new Map<string, HTMLElement>())
  const scenes = segments.flatMap((segment): Scene[] => {
    const time = segmentTimeRange(shot, segment)
    return time === undefined || segment.timelineIndex === undefined
      ? []
      : [{ number: segment.timelineIndex + 1, segment, time }]
  })
  const settings = segments.find((segment) => segment.kind === 'global')
  const total = formatTimecode(timelineDuration(shot))

  // 焦点落进这段（点正文、Tab 进来）或点段标题就选中；已选中的段再点、再打字不重置帧。
  const select = (segment: ShotContent) => {
    if (segment.id !== selectedId) onSelect(segment.id)
  }
  const jumpTo = (segment: ShotContent) => {
    select(segment)
    // 平滑与否交给滚动容器的 scroll-behavior，减少动效时样式里关掉。
    itemsRef.current.get(segment.id)?.scrollIntoView({ block: 'nearest' })
  }
  const copyButton = (segment: ShotContent) => (
    <IconButton
      className="storyboard-segment-copy"
      label={`复制${contentLabel(segment)}`}
      name="copy"
      onClick={() => void copyWithToast(segment.prompt ?? '', '已复制')}
      size="sm"
    />
  )
  const editor = (segment: ShotContent, selected: boolean) => (
    <PromptEditor
      aria-label={segment.kind === 'global' ? segment.title : `${contentLabel(segment)} 的描述`}
      aspectRatio={aspectRatio}
      frames={shot.image_urls}
      highlighted={selected ? frameNumber : undefined}
      // 插进去的那帧上舞台，与其它添加入口一致。
      mention={{ add, onInserted: (number) => onSelect(segment.id, number) }}
      onChange={(text) => onUpdateShot((current) => updateContentPrompt(current, segment.id, text))}
      onPickFrame={(number) => {
        if (number >= 1 && number <= shot.image_urls.length) onSelect(segment.id, number)
      }}
      readOnly={readOnly}
      ref={editorRef(segment.id)}
      value={segment.prompt ?? ''}
    />
  )

  return (
    <div
      aria-label="分镜文案"
      className="storyboard-prose"
      onPasteCapture={onPasteCapture}
      role="region"
    >
      <div className="storyboard-script-head">
        <div className="flex min-h-7 items-center gap-2">
          <p className="min-w-0 text-body-sm text-on-surface-muted tabular-nums">
            <span className="text-body font-semibold text-on-surface">{scenes.length} 个镜头</span>
            {` · 共 ${total}`}
          </p>
          <Button
            className="ml-auto h-7 px-2.5 text-label text-on-surface-variant"
            onClick={() => setCompact((current) => !current)}
            size="md"
            variant="ghost"
          >
            {compact ? '显示全文' : '收成摘要'}
          </Button>
        </div>
        <div aria-label="镜头时间条" className="storyboard-timeline" role="group">
          {scenes.map(({ segment, time }) => {
            const summary = [
              contentLabel(segment),
              formatTimecode(time.duration),
              formatTimeRange(time),
            ]
            return (
              <TooltipRoot key={segment.id}>
                <TooltipTrigger asChild>
                  <button
                    aria-current={segment.id === selectedId}
                    aria-label={summary.join('，')}
                    className="storyboard-timeline-segment ui-focus"
                    onClick={() => jumpTo(segment)}
                    // 按原始起止秒排比例，不用取整后的时长。
                    style={{ flexGrow: time.end - time.start }}
                    type="button"
                  />
                </TooltipTrigger>
                <TooltipContent>{summary.join(' · ')}</TooltipContent>
              </TooltipRoot>
            )
          })}
        </div>
        <div aria-hidden className="storyboard-timeline-ticks">
          <span>{formatTimecode(0)}</span>
          <span>{total}</span>
        </div>
      </div>
      <div className="storyboard-script-list">
        {settings === undefined ? null : (
          <SettingsCard
            clamped={compact && settings.id !== selectedId && !settingsExpanded}
            copy={copyButton(settings)}
            expansion={
              compact && settings.id !== selectedId
                ? { expanded: settingsExpanded, toggle: () => setSettingsExpanded((v) => !v) }
                : undefined
            }
            onFocus={() => select(settings)}
            prompt={settings.prompt ?? ''}
            selected={settings.id === selectedId}
          >
            {editor(settings, settings.id === selectedId)}
          </SettingsCard>
        )}
        <ol className="storyboard-shots">
          {scenes.map(({ number, segment, time }) => {
            const selected = segment.id === selectedId
            const label = contentLabel(segment)
            return (
              <li
                className="storyboard-shot"
                key={segment.id}
                ref={(element) => {
                  if (element !== null) itemsRef.current.set(segment.id, element)
                  return () => {
                    itemsRef.current.delete(segment.id)
                  }
                }}
              >
                <span aria-hidden className="storyboard-rail">
                  <span className="storyboard-rail-node">{number}</span>
                  <span className="storyboard-rail-stamp">{formatTimecode(time.start)}</span>
                </span>
                <div
                  aria-current={selected}
                  aria-label={label}
                  className="storyboard-segment"
                  data-clamped={compact && !selected}
                  onFocus={() => select(segment)}
                  role="group"
                >
                  <div className="storyboard-segment-head">
                    <h4 className="text-title font-semibold text-on-surface">
                      <button
                        className="cursor-pointer rounded-xs ui-focus"
                        onClick={() => select(segment)}
                        type="button"
                      >
                        {label}
                      </button>
                    </h4>
                    <DurationPill time={time} />
                    <span className="ml-auto flex items-center gap-1">
                      {segment.frameNumbers.length === 0 ? null : (
                        <span className="storyboard-frame-stack">
                          {segment.frameNumbers.map((frame) => (
                            <button
                              aria-label={`在舞台查看 @${frame}`}
                              className="ui-focus"
                              key={frame}
                              onClick={() => onSelect(segment.id, frame)}
                              onFocus={keepFocusInside}
                              type="button"
                            >
                              <img alt="" src={shot.image_urls[frame - 1]} />
                            </button>
                          ))}
                        </span>
                      )}
                      {copyButton(segment)}
                    </span>
                  </div>
                  {editor(segment, selected)}
                </div>
              </li>
            )
          })}
        </ol>
        <div aria-hidden className="storyboard-shot-end">
          <span className="storyboard-rail">
            <span className="storyboard-rail-end" />
            <span className="storyboard-rail-stamp">{total}</span>
          </span>
          <span className="storyboard-shot-end-label">结束</span>
        </div>
      </div>
    </div>
  )
}

/** 时长胶囊：显示时长，悬停提示与读屏给完整区间。 */
function DurationPill({ time }: { time: SegmentTime }) {
  const range = formatTimeRange(time)
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span className="storyboard-duration">
          <Icon decorative name="duration" size="xs" />
          {formatTimecode(time.duration)}
          <span className="sr-only">，{range}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{range}</TooltipContent>
    </TooltipRoot>
  )
}

type SettingsCardProps = {
  prompt: string
  selected: boolean
  /** 收成摘要时只露三行。 */
  clamped: boolean
  /** 收成摘要且没选中时才有「展开 / 收起」；选中时本来就是全文。 */
  expansion: { expanded: boolean; toggle: () => void } | undefined
  copy: ReactNode
  onFocus: () => void
  children: ReactNode
}

/** 全局设定卡：标题旁写字数；正文按原文换行分段，不识别任何关键词。 */
function SettingsCard({
  children,
  clamped,
  copy,
  expansion,
  onFocus,
  prompt,
  selected,
}: SettingsCardProps) {
  return (
    <div
      aria-current={selected}
      aria-label="全局设定"
      className="storyboard-segment storyboard-settings"
      data-clamped={clamped}
      onFocus={onFocus}
      role="group"
    >
      <div className="storyboard-segment-head">
        <span className="storyboard-settings-label">
          <Icon decorative name="filter" size="xs" />
          全局设定
        </span>
        <span className="storyboard-settings-count">{promptLength(prompt)} 字</span>
        <span className="ml-auto flex items-center gap-0.5">
          {copy}
          {expansion === undefined ? null : (
            <Button
              aria-expanded={expansion.expanded}
              className="h-7 gap-1 px-2 text-label text-on-surface-variant"
              onClick={expansion.toggle}
              onFocus={keepFocusInside}
              size="md"
              trailingIcon={expansion.expanded ? 'collapse' : 'expand'}
              variant="ghost"
            >
              {expansion.expanded ? '收起' : '展开'}
            </Button>
          )}
        </span>
      </div>
      {children}
    </div>
  )
}
