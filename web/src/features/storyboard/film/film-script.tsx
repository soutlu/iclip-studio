import { Fragment, useRef, useState, type FocusEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { refuseFileDropProps } from '@/shared/ui/file-drop'
import { shotAccentOf } from '../shot-accent'
import { formatTimecode, promptLength } from '../shot-content'
import { copyWithToast } from '../components/copy-with-toast'
import { DurationPill, ScriptHead } from '../components/script-head'
import type { FilmGroup, FilmSetting, FilmShot } from './film.api'
import {
  SETTINGS_ID,
  filmDuration,
  frameTag,
  settingSeparator,
  settingText,
  shotContentId,
  shotText,
  shotTime,
} from './film-content'
import { FilmFrameChipsProvider } from './film-frame-chip'
import { FilmImageChip } from './film-image-chip'
import { FilmTextEditor, type FilmTextInsert } from './film-text-editor'
import type { FilmSegmentValue } from './use-film-draft'

type FilmScriptProps = {
  group: FilmGroup
  selectedId: string | undefined
  frame: number | undefined
  readOnly: boolean
  onSelect: (contentId: string, frame?: number) => void
  onPickFrame: (position: number) => void
  onEdit: (target: string, label: string, value: FilmSegmentValue) => void
  onPreview: (media: { name: string; url: string }) => void
  uploads: boolean
  onUploadingChange: (key: string, uploading: boolean) => void
  copyBlocked: string | undefined
}

const keepFocusInside = (event: FocusEvent) => event.stopPropagation()

const copyButton = (label: string, text: string, blocked: string | undefined) => (
  <IconButton
    className="storyboard-segment-copy"
    disabled={blocked !== undefined}
    label={`复制${label}`}
    name="copy"
    onClick={() => void copyWithToast(text, '已复制')}
    size="sm"
    tooltip={blocked}
  />
)

const frameAt = (group: FilmGroup, node: string | null) => {
  const index = node === null ? -1 : group.frames.findIndex((frame) => frame.node === node)
  const frame = group.frames[index]
  return frame === undefined ? undefined : { frame, position: index + 1 }
}

export function FilmScript({
  copyBlocked,
  frame,
  group,
  onEdit,
  onPickFrame,
  onPreview,
  onSelect,
  onUploadingChange,
  readOnly,
  selectedId,
  uploads,
}: FilmScriptProps) {
  const [compact, setCompact] = useState(false)
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const itemsRef = useRef(new Map<string, HTMLElement>())
  const scenes = group.shots.map((shot, index) => ({
    accent: shotAccentOf(index),
    id: shotContentId(index + 1),
    label: `镜头 ${index + 1}`,
    shot,
    time: shotTime(shot),
  }))
  const total = filmDuration(group)

  const select = (id: string) => {
    if (id !== selectedId) onSelect(id)
  }
  const settingsSelected = selectedId === SETTINGS_ID
  const settingsClamped = compact && !settingsSelected
  const chipsOf = (id: string, selected: boolean) => ({
    frames: group.frames,
    highlighted: selected ? frame : undefined,
    onEnlarge: onPreview,
    onPick: (position: number) => onSelect(id, position),
  })
  const insertOf = (key: string): FilmTextInsert | undefined =>
    readOnly
      ? undefined
      : { group, onUploadingChange: (busy) => onUploadingChange(key, busy), uploads }
  const strip = group.frames.every((item) => item.number === null) ? null : (
    <FrameStrip frame={frame} group={group} onPick={onPickFrame} onPreview={onPreview} />
  )

  return (
    <div aria-label="分镜文案" className="storyboard-prose" role="region" {...refuseFileDropProps}>
      <ScriptHead
        compact={compact}
        onJump={(id) => {
          select(id)
          itemsRef.current.get(id)?.scrollIntoView({ block: 'nearest' })
        }}
        onToggleCompact={() => setCompact((current) => !current)}
        scenes={scenes}
        selectedId={selectedId}
        total={total}
      />
      <div className="storyboard-script-list">
        {group.settings.length === 0 ? (
          strip === null ? null : (
            <div className="film-frames-row">
              <span className="storyboard-settings-label">
                <Icon decorative name="image" size="xs" />
                参考图
              </span>
              {strip}
            </div>
          )
        ) : (
          <div
            aria-current={settingsSelected}
            aria-label="全局设定"
            className="storyboard-segment storyboard-settings"
            data-clamped={settingsClamped && !settingsExpanded}
            onFocus={() => select(SETTINGS_ID)}
            role="group"
          >
            <div className="storyboard-segment-head film-settings-head">
              <span className="storyboard-settings-label">
                <Icon decorative name="filter" size="xs" />
                全局设定
              </span>
              <span className="storyboard-settings-count">
                {promptLength(group.settings.map(settingText).join('\n'))} 字
              </span>
              {strip}
              <span className="film-settings-actions ml-auto flex items-center gap-0.5">
                {copyButton('全局设定', group.settings.map(settingText).join('\n'), copyBlocked)}
                {settingsClamped ? (
                  <Button
                    aria-expanded={settingsExpanded}
                    className="h-7 gap-1 px-2 text-label text-on-surface-variant"
                    onClick={() => setSettingsExpanded((current) => !current)}
                    onFocus={keepFocusInside}
                    size="md"
                    trailingIcon={settingsExpanded ? 'collapse' : 'expand'}
                    variant="ghost"
                  >
                    {settingsExpanded ? '收起' : '展开'}
                  </Button>
                ) : null}
              </span>
            </div>
            <FilmFrameChipsProvider value={chipsOf(SETTINGS_ID, settingsSelected)}>
              <div className="film-segment-body">
                {group.settings.map((setting) => (
                  <SettingRow
                    insert={
                      !setting.shared && setting.target !== null
                        ? insertOf(setting.target)
                        : undefined
                    }
                    key={setting.target ?? `${setting.kind}:${setting.label ?? ''}:${setting.text}`}
                    onEdit={onEdit}
                    readOnly={readOnly}
                    setting={setting}
                  />
                ))}
              </div>
            </FilmFrameChipsProvider>
          </div>
        )}
        <ol className="storyboard-shots">
          {scenes.map(({ accent, id, label, shot, time }, index) => {
            const selected = id === selectedId
            const view = frameAt(group, shot.view)
            return (
              <li
                className="storyboard-shot"
                key={id}
                ref={(element) => {
                  if (element !== null) itemsRef.current.set(id, element)
                  return () => {
                    itemsRef.current.delete(id)
                  }
                }}
              >
                <span aria-hidden className="storyboard-rail">
                  <span className={cn('storyboard-rail-tick', accent.tick)} />
                  <span className="storyboard-rail-number">{index + 1}</span>
                  <span className="storyboard-rail-stamp">{formatTimecode(time.start)}</span>
                </span>
                <div
                  aria-current={selected}
                  aria-label={label}
                  className="storyboard-segment"
                  data-clamped={compact && !selected}
                  onFocus={() => select(id)}
                  role="group"
                >
                  <div className="storyboard-segment-head">
                    <h4 className="text-title font-semibold text-on-surface">
                      <button
                        className="cursor-pointer rounded-xs ui-focus"
                        onClick={() => select(id)}
                        type="button"
                      >
                        {label}
                      </button>
                    </h4>
                    <DurationPill time={time} />
                    <span className="ml-auto flex items-center gap-1">
                      {view === undefined ? null : (
                        <span className="storyboard-frame-stack">
                          <button
                            aria-label={`在舞台查看${label}的画面`}
                            className="ui-focus"
                            onClick={() => onSelect(id, view.position)}
                            onFocus={keepFocusInside}
                            type="button"
                          >
                            {view.frame.url === null ? null : <img alt="" src={view.frame.url} />}
                          </button>
                        </span>
                      )}
                      {copyButton(label, shotText(shot), copyBlocked)}
                    </span>
                  </div>
                  <FilmFrameChipsProvider value={chipsOf(id, selected)}>
                    <ShotBody
                      insertOf={insertOf}
                      label={label}
                      lead={
                        view?.frame.number == null ? undefined : `参考@Image${view.frame.number}，`
                      }
                      onEdit={onEdit}
                      readOnly={readOnly}
                      shot={shot}
                    />
                  </FilmFrameChipsProvider>
                </div>
              </li>
            )
          })}
        </ol>
        <div aria-hidden className="storyboard-shot-end">
          <span className="storyboard-rail">
            <span className="storyboard-rail-stamp">{formatTimecode(total)}</span>
          </span>
          <span className="storyboard-shot-end-label">结束</span>
        </div>
      </div>
    </div>
  )
}

function FrameStrip({
  frame,
  group,
  onPick,
  onPreview,
}: {
  frame: number | undefined
  group: FilmGroup
  onPick: (position: number) => void
  onPreview: FilmScriptProps['onPreview']
}) {
  return (
    <div aria-label="参考图" className="film-frames" role="group">
      {group.frames.flatMap((item, index) =>
        item.number === null
          ? []
          : [
              <FilmImageChip
                highlighted={frame === index + 1}
                key={item.node}
                label={item.label}
                note={item.url === null ? '未选用' : undefined}
                onEnlarge={(url) => onPreview({ name: item.label, url })}
                onPick={() => onPick(index + 1)}
                tag={frameTag(item)}
                url={item.url}
              />,
            ],
      )}
    </div>
  )
}

function SettingRow({
  insert,
  onEdit,
  readOnly,
  setting,
}: {
  insert: FilmTextInsert | undefined
  onEdit: FilmScriptProps['onEdit']
  readOnly: boolean
  setting: FilmSetting
}) {
  const name = setting.label ?? '拍法'
  const { target } = setting
  return (
    <div className="film-setting">
      {setting.label === null ? null : (
        <span className="film-setting-label">
          {setting.label}
          {settingSeparator(setting).replace(' ', ' ')}
        </span>
      )}
      <FilmTextEditor
        aria-label={name}
        insert={insert}
        onChange={(text) => {
          if (target !== null) onEdit(target, name, { kind: 'text', text })
        }}
        readOnly={readOnly || target === null}
        value={setting.text}
      />
    </div>
  )
}

type Padded = { lead: string; core: string; trail: string }

const splitPadding = (text: string): Padded => {
  const core = text.trim()
  if (core === '') return { core, lead: text, trail: '' }
  const start = text.indexOf(core)
  return { core, lead: text.slice(0, start), trail: text.slice(start + core.length) }
}

function ShotBody({
  insertOf,
  label,
  lead,
  onEdit,
  readOnly,
  shot,
}: {
  insertOf: (key: string) => FilmTextInsert | undefined
  label: string
  lead: string | undefined
  onEdit: FilmScriptProps['onEdit']
  readOnly: boolean
  shot: FilmShot
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [emitted, setEmitted] = useState<ReadonlyMap<number, Padded>>(() => new Map())
  const { target } = shot
  const parts = shot.parts.map((text, index) => {
    const last = emitted.get(index)
    return last !== undefined && last.lead + last.core + last.trail === text
      ? last
      : splitPadding(text)
  })
  const empty = parts.every((part) => part.core === '')
  const lines = shot.lines.map((line) => line.text)
  const change = (next: { parts?: string[]; lines?: string[] }) => {
    if (target === null) return
    onEdit(target, label, {
      kind: 'shot',
      lines: next.lines ?? lines,
      parts: next.parts ?? [...shot.parts],
    })
  }
  const locked = readOnly || target === null
  return (
    <div className="film-segment-body">
      {parts.map((part, index) => {
        const line = shot.lines[index - 1]
        const shown = part.core !== '' || editing === index || (empty && index === 0)
        return (
          <Fragment key={line?.target ?? 'lead'}>
            {line === undefined ? null : (
              <div className="film-line">
                <span className="film-line-role">{line.role}</span>
                <FilmTextEditor
                  aria-label={`${label} ${line.role}的台词`}
                  className="film-line-words"
                  onChange={(text) =>
                    change({ lines: lines.map((item, at) => (at === index - 1 ? text : item)) })
                  }
                  readOnly={locked}
                  singleLine
                  value={line.text}
                />
              </div>
            )}
            {shown ? (
              <div
                onBlur={() => setEditing((current) => (current === index ? null : current))}
                onFocus={() => setEditing(index)}
              >
                <FilmTextEditor
                  aria-label={`${label}的描述`}
                  insert={target === null ? undefined : insertOf(`${target}#${String(index)}`)}
                  lockedLead={index === 0 ? lead : undefined}
                  onChange={(text) => {
                    setEmitted((current) => new Map(current).set(index, { ...part, core: text }))
                    change({
                      parts: parts.map((item, at) =>
                        at === index
                          ? part.lead + text + part.trail
                          : item.lead + item.core + item.trail,
                      ),
                    })
                  }}
                  readOnly={locked}
                  value={part.core}
                />
              </div>
            ) : null}
          </Fragment>
        )
      })}
    </div>
  )
}
