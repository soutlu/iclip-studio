/** 制作页的文案列：列头与分镜页相同（`ScriptHead`）；正文区最上面是全局设定卡，之后按时间排各镜头，末尾一行写总长与「结束」。
 *
 * 全局设定一段一行：拍法只有字，出场元素与声音前面写称呼，元素挂着图的在称呼后放一枚图片芯片，点它看那张图。
 * 镜头正文与台词交替排：台词单独一行，说话人是固定的小标签，只能改引号里的字。没法在页面上改的段只读。
 * 点哪段选中哪段，舞台跟着切到它挂的图。列里不收拖进来的文件，免得漏给聊天输入框。 */

import { Fragment, useRef, useState, type FocusEvent, type ReactNode } from 'react'
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
  settingText,
  shotContentId,
  shotText,
  shotTime,
} from './film-content'
import { FilmImageChip } from './film-image-chip'
import { FilmTextEditor } from './film-text-editor'
import type { FilmSegmentValue } from './use-film-draft'

type FilmScriptProps = {
  group: FilmGroup
  /** 选中的段；舞台在看成片时为 undefined，哪段都不标。 */
  selectedId: string | undefined
  /** 舞台上那张图在 `frames` 里的位置，对应的图片芯片高亮。 */
  frame: number | undefined
  readOnly: boolean
  onSelect: (contentId: string, frame?: number) => void
  /** 一段字改了：`label` 是这段给人看的名字，冲突时用。 */
  onEdit: (target: string, label: string, value: FilmSegmentValue) => void
  /** 图片芯片预览卡上的「放大」。 */
  onPreview: (media: { name: string; url: string }) => void
}

// 段里自带选中动作的控件（展开全局设定、点图片）聚焦时不再走「焦点进段就选中」，免得先选段再选图跳两次。
const keepFocusInside = (event: FocusEvent) => event.stopPropagation()

const copyButton = (label: string, text: string) => (
  <IconButton
    className="storyboard-segment-copy"
    label={`复制${label}`}
    name="copy"
    onClick={() => void copyWithToast(text, '已复制')}
    size="sm"
  />
)

/** 一张图在 `frames` 里的位置与它本身；不在这组里为 undefined。 */
const frameAt = (group: FilmGroup, node: string | null) => {
  const index = node === null ? -1 : group.frames.findIndex((frame) => frame.node === node)
  const frame = group.frames[index]
  return frame === undefined ? undefined : { frame, position: index + 1 }
}

export function FilmScript({
  frame,
  group,
  onEdit,
  onPreview,
  onSelect,
  readOnly,
  selectedId,
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

  // 焦点落进这段（点正文、Tab 进来）或点段标题就选中；已选中的段再点、再打字不重置图。
  const select = (id: string) => {
    if (id !== selectedId) onSelect(id)
  }
  const settingsSelected = selectedId === SETTINGS_ID
  const settingsClamped = compact && !settingsSelected

  return (
    <div aria-label="分镜文案" className="storyboard-prose" role="region" {...refuseFileDropProps}>
      <ScriptHead
        compact={compact}
        onJump={(id) => {
          select(id)
          // 平滑与否交给滚动容器的 scroll-behavior，减少动效时样式里关掉。
          itemsRef.current.get(id)?.scrollIntoView({ block: 'nearest' })
        }}
        onToggleCompact={() => setCompact((current) => !current)}
        scenes={scenes}
        selectedId={selectedId}
        total={total}
      />
      <div className="storyboard-script-list">
        {group.settings.length === 0 ? null : (
          <div
            aria-current={settingsSelected}
            aria-label="全局设定"
            className="storyboard-segment storyboard-settings"
            data-clamped={settingsClamped && !settingsExpanded}
            onFocus={() => select(SETTINGS_ID)}
            role="group"
          >
            <div className="storyboard-segment-head">
              <span className="storyboard-settings-label">
                <Icon decorative name="filter" size="xs" />
                全局设定
              </span>
              <span className="storyboard-settings-count">
                {promptLength(group.settings.map(settingText).join('\n'))} 字
              </span>
              <span className="ml-auto flex items-center gap-0.5">
                {copyButton('全局设定', group.settings.map(settingText).join('\n'))}
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
            <div className="film-segment-body">
              {group.settings.map((setting) => (
                <SettingRow
                  chip={(() => {
                    const found = frameAt(group, setting.image)
                    return found === undefined ? null : (
                      <FilmImageChip
                        // 全局设定是选中的段，舞台又正在看它，才算这枚芯片的。
                        highlighted={settingsSelected && frame === found.position}
                        label={found.frame.label}
                        onEnlarge={(url) => onPreview({ name: found.frame.label, url })}
                        onPick={() => onSelect(SETTINGS_ID, found.position)}
                        tag={frameTag(found.frame)}
                        url={found.frame.url}
                      />
                    )
                  })()}
                  // 同一组里每段设定的 target 各不相同；没法改的段没有 target，按种类与称呼认。
                  key={setting.target ?? `${setting.kind}:${setting.label ?? ''}`}
                  onEdit={onEdit}
                  readOnly={readOnly}
                  setting={setting}
                />
              ))}
            </div>
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
                      {copyButton(label, shotText(shot))}
                    </span>
                  </div>
                  <ShotBody label={label} onEdit={onEdit} readOnly={readOnly} shot={shot} />
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

/** 全局设定的一段：称呼与图片芯片浮在左边，字从它们后面接着排、折行回到行首。 */
function SettingRow({
  chip,
  onEdit,
  readOnly,
  setting,
}: {
  chip: ReactNode
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
          {setting.label}：{chip}
        </span>
      )}
      <FilmTextEditor
        aria-label={name}
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

/** 一段文字去掉首尾空白后的样子，连同原来的首尾空白；改字只改中间，首尾照旧，文件排版不变。 */
const splitPadding = (text: string): Padded => {
  const core = text.trim()
  if (core === '') return { core, lead: text, trail: '' }
  const start = text.indexOf(core)
  return { core, lead: text.slice(0, start), trail: text.slice(start + core.length) }
}

/** 镜头正文：台词前后的文字各是一段，台词单独一行。只有空白的那段不画（排版留下的换行），正在改的那段照画，
 * 删空了也不会从手底下消失；整镜都没有字时画第一段，好往里写。 */
function ShotBody({
  label,
  onEdit,
  readOnly,
  shot,
}: {
  label: string
  onEdit: FilmScriptProps['onEdit']
  readOnly: boolean
  shot: FilmShot
}) {
  const [editing, setEditing] = useState<number | null>(null)
  // 每段最近交出去的样子：字的头尾正好是空格或空行时（刚敲的），重新去首尾空白会把它吃掉、把光标重置，
  // 所以只要这段还是交出去的那个样子，就按交出去时的拆法显示。
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
          // 第 i 段跟在第 i 句台词后面，用那句的 target 认；第一段前面没有台词。
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
