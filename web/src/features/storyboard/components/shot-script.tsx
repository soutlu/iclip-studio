import { useRef, useState, type FocusEvent, type ReactNode, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { refuseFileDropProps, useFileDropTarget } from '@/shared/ui/file-drop'
import {
  contentLabel,
  formatTimecode,
  promptLength,
  segmentTimeRange,
  timelineDuration,
  updateContentPrompt,
  type SegmentTime,
  type ShotContent,
} from '../shot-content'
import { shotAccentOf, type ShotAccent } from '../shot-accent'
import type { Shot } from '../shot-document'
import { copyWithToast } from './copy-with-toast'
import { PromptEditor, type PromptEditorHandle, type PromptImages } from './prompt-editor'
import { DurationPill, ScriptHead } from './script-head'

type ScriptDrop = {
  blocked: boolean
  onFiles: (content: string, files: readonly File[]) => void
  onDirectory: (content: string) => void
}

type ShotScriptProps = {
  shot: Shot
  aspectRatio: string
  add: (content: string) => void
  images: (content: string) => PromptImages | undefined
  drop: ScriptDrop
  segments: readonly ShotContent[]
  selectedId: string | undefined
  frameNumber: number | undefined
  readOnly: boolean
  editorRef: (id: string) => Ref<PromptEditorHandle>
  onSelect: (content: string, frame?: number) => void
  onUpdateShot: (updater: (current: Shot) => Shot) => unknown
}

type Scene = { segment: ShotContent; number: number; time: SegmentTime; accent: ShotAccent }

const keepFocusInside = (event: FocusEvent) => event.stopPropagation()

export function ShotScript({
  add,
  aspectRatio,
  drop,
  editorRef,
  frameNumber,
  images,
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
      : [
          {
            accent: shotAccentOf(segment.timelineIndex),
            number: segment.timelineIndex + 1,
            segment,
            time,
          },
        ]
  })
  const settings = segments.find((segment) => segment.kind === 'global')

  const select = (segment: ShotContent) => {
    if (segment.id !== selectedId) onSelect(segment.id)
  }
  const jumpTo = (segment: ShotContent) => {
    select(segment)
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
      images={images(segment.id)}
      mention={{ add: () => add(segment.id), onInserted: (number) => onSelect(segment.id, number) }}
      onChange={(text) => onUpdateShot((current) => updateContentPrompt(current, segment.id, text))}
      onPickFrame={(number) => {
        if (number >= 1 && number <= shot.image_urls.length) onSelect(segment.id, number)
      }}
      readOnly={readOnly}
      ref={editorRef(segment.id)}
      value={segment.prompt ?? ''}
    />
  )
  const segmentDrop = (segment: ShotContent): SegmentDrop => ({
    blocked: drop.blocked,
    onDirectory: () => drop.onDirectory(segment.id),
    onFiles: (files) => drop.onFiles(segment.id, files),
  })

  return (
    <div aria-label="分镜文案" className="storyboard-prose" role="region" {...refuseFileDropProps}>
      <ScriptHead
        compact={compact}
        onJump={(id) => {
          const segment = segments.find((item) => item.id === id)
          if (segment !== undefined) jumpTo(segment)
        }}
        onToggleCompact={() => setCompact((current) => !current)}
        scenes={scenes.map(({ accent, segment, time }) => ({
          accent,
          id: segment.id,
          label: contentLabel(segment),
          time,
        }))}
        selectedId={selectedId}
        total={timelineDuration(shot)}
      />
      <div className="storyboard-script-list">
        {settings === undefined ? null : (
          <SettingsCard
            clamped={compact && settings.id !== selectedId && !settingsExpanded}
            copy={copyButton(settings)}
            drop={segmentDrop(settings)}
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
          {scenes.map(({ accent, number, segment, time }) => {
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
                  <span className={cn('storyboard-rail-tick', accent.tick)} />
                  <span className="storyboard-rail-number">{number}</span>
                  <span className="storyboard-rail-stamp">{formatTimecode(time.start)}</span>
                </span>
                <SegmentCard
                  clamped={compact && !selected}
                  drop={segmentDrop(segment)}
                  label={label}
                  onFocus={() => select(segment)}
                  selected={selected}
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
                </SegmentCard>
              </li>
            )
          })}
        </ol>
        <div aria-hidden className="storyboard-shot-end">
          <span className="storyboard-rail">
            <span className="storyboard-rail-stamp">{formatTimecode(timelineDuration(shot))}</span>
          </span>
          <span className="storyboard-shot-end-label">结束</span>
        </div>
      </div>
    </div>
  )
}

type SegmentDrop = Parameters<typeof useFileDropTarget>[0]

type SegmentCardProps = {
  label: string
  selected: boolean
  clamped: boolean
  drop: SegmentDrop
  onFocus: () => void
  className?: string
  children: ReactNode
}

function SegmentCard({
  children,
  clamped,
  className,
  drop,
  label,
  onFocus,
  selected,
}: SegmentCardProps) {
  const target = useFileDropTarget(drop)
  return (
    <div
      aria-current={selected}
      aria-label={label}
      className={cn('storyboard-segment', className)}
      data-clamped={clamped}
      onFocus={onFocus}
      role="group"
      {...target.dragHandlers}
    >
      {children}
      {target.dragOver ? (
        <div aria-hidden className="storyboard-drop bg-glass-surface">
          <span className="storyboard-drop-hint">
            <Icon decorative name="add-file" size="md" />
            松开可添加到{label}
          </span>
        </div>
      ) : null}
    </div>
  )
}

type SettingsCardProps = {
  prompt: string
  selected: boolean
  clamped: boolean
  drop: SegmentDrop
  expansion: { expanded: boolean; toggle: () => void } | undefined
  copy: ReactNode
  onFocus: () => void
  children: ReactNode
}

function SettingsCard({
  children,
  clamped,
  copy,
  drop,
  expansion,
  onFocus,
  prompt,
  selected,
}: SettingsCardProps) {
  return (
    <SegmentCard
      className="storyboard-settings"
      clamped={clamped}
      drop={drop}
      label="全局设定"
      onFocus={onFocus}
      selected={selected}
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
    </SegmentCard>
  )
}
