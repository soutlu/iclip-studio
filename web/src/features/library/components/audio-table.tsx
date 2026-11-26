import { useState } from 'react'
import type { AudioKind, ReferenceAudio } from '@/shared/api/reference-audios'
import { cn } from '@/shared/lib/utils'
import {
  AudioCover,
  AuditionBuffering,
  AuditionButton,
  AuditionProgressLine,
  audioDurationText,
  bgmStyleText,
  bpmText,
  localeLabel,
  scenariosText,
  sfxCategoryText,
  voiceToneText,
  type Audition,
} from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { RowClock, RowWaveform } from './audio-row-progress'

/** 每行能做的：试听（同一时间只放一条）、改、移除。 */
export type AudioRowActions = {
  audition: Audition
  onToggle: (audio: ReferenceAudio) => void
  onEdit: (audio: ReferenceAudio) => void
  onRemove: (audio: ReferenceAudio) => void
}

// 窄时只留封面、名称描述、时长和操作；放得下（容器够宽）时再露出属性列
const GRID: Readonly<Record<AudioKind, string>> = {
  voice:
    'grid-cols-[44px_minmax(0,1fr)_46px_102px] @4xl:grid-cols-[44px_minmax(0,1fr)_78px_94px_164px_46px_102px]',
  bgm: 'grid-cols-[44px_minmax(0,1fr)_46px_68px] @4xl:grid-cols-[44px_minmax(0,1.05fr)_minmax(0,1.35fr)_128px_66px_46px_68px]',
  sfx: 'grid-cols-[36px_minmax(0,1fr)_46px_68px] @4xl:grid-cols-[36px_minmax(0,1fr)_minmax(0,1.45fr)_92px_46px_68px]',
}

// 行之间的细线从名称列开始：左内边距 + 封面（音效是圆形试听键）+ 列间距
const DIVIDER_FROM: Readonly<Record<AudioKind, string>> = {
  voice: 'after:left-18',
  bgm: 'after:left-18',
  sfx: 'after:left-16',
}

const HEADS: Readonly<
  Record<AudioKind, readonly { label: string; wide?: boolean; end?: boolean }[]>
> = {
  voice: [
    { label: '音色' },
    { label: '语种', wide: true },
    { label: '声线', wide: true },
    { label: '适用场景', wide: true },
    { label: '时长' },
  ],
  bgm: [
    { label: '配乐' },
    { label: '声波预览', wide: true },
    { label: '风格与情绪', wide: true },
    { label: '节奏', wide: true, end: true },
    { label: '时长' },
  ],
  sfx: [
    { label: '音效' },
    { label: '瞬态波形', wide: true },
    { label: '分类', wide: true },
    { label: '时长' },
  ],
}

const ROW_GRID = 'grid items-center gap-x-4 px-3'

const WIDE_CELL = 'hidden min-w-0 truncate text-body-sm text-on-surface @4xl:block'

/** 一个子类的表格：列头加各行，音色、配乐、音效各有一套列。 */
export function AudioTable({
  kind,
  items,
  actions,
  label,
}: {
  kind: AudioKind
  items: readonly ReferenceAudio[]
  actions: AudioRowActions
  label: string
}) {
  return (
    <div className="@container">
      <div
        aria-hidden
        className={cn(
          ROW_GRID,
          GRID[kind],
          'border-b border-hairline pb-2 text-caption text-on-surface-faint',
        )}
      >
        <span />
        {HEADS[kind].map((head) => (
          <span
            className={cn(
              head.wide === true && 'hidden @4xl:block',
              head.end === true && 'text-right',
            )}
            key={head.label}
          >
            {head.label}
          </span>
        ))}
        <span />
      </div>
      <ul aria-label={label} className="flex flex-col">
        {items.map((audio) => (
          <AudioRow actions={actions} audio={audio} key={audio.id} />
        ))}
      </ul>
    </div>
  )
}

function AudioRow({ audio, actions }: { audio: ReferenceAudio; actions: AudioRowActions }) {
  const { audition, onToggle, onEdit, onRemove } = actions
  const [expanded, setExpanded] = useState(false)
  const current = audition.current === audio.id
  const playing = audition.playing === audio.id
  const voice = audio.audioKind === 'voice'
  return (
    <li
      className={cn(
        'group/row relative rounded-md after:absolute after:right-3 after:bottom-0 after:h-px after:bg-hairline last:after:hidden',
        DIVIDER_FROM[audio.audioKind],
        current ? 'bg-card shadow-card ring-1 ring-hairline after:hidden' : 'hover:bg-state-hover',
      )}
    >
      <div className={cn(ROW_GRID, GRID[audio.audioKind], 'py-3')}>
        {audio.audioKind === 'sfx' ? (
          <AuditionButton
            label={playing ? `暂停试听：${audio.title}` : `试听：${audio.title}`}
            onToggle={() => onToggle(audio)}
            playing={playing}
          >
            {current ? <AuditionBuffering audition={audition} /> : null}
          </AuditionButton>
        ) : (
          <AudioCover
            id={audio.id}
            onToggle={() => onToggle(audio)}
            state={playing ? 'playing' : current ? 'paused' : 'idle'}
            title={audio.title}
          >
            {current ? <AuditionBuffering audition={audition} /> : null}
          </AudioCover>
        )}
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-on-surface" title={audio.title}>
            {audio.title}
          </p>
          {audio.description === null ? null : (
            <p className="truncate text-body-sm text-on-surface-faint" title={audio.description}>
              {audio.description}
            </p>
          )}
          {current ? (
            <AuditionProgressLine
              audition={audition}
              className="mt-1.5 max-w-75"
              durationMs={audio.durationMs}
            />
          ) : null}
        </div>
        <TraitCells audio={audio} audition={audition} current={current} />
        <span
          className={cn(
            'text-body-sm tabular-nums',
            current ? 'text-on-surface' : 'text-on-surface-faint',
          )}
        >
          {current ? (
            <RowClock audio={audio} audition={audition} />
          ) : (
            audioDurationText(audio.durationMs)
          )}
        </span>
        <div
          className={cn(
            'flex items-center justify-end',
            !current &&
              !expanded &&
              'pointer-fine:opacity-0 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100',
          )}
        >
          {voice ? (
            <IconButton
              aria-expanded={expanded}
              className={expanded ? 'bg-state-active text-on-surface' : undefined}
              label={`台词：${audio.title}`}
              name="captions"
              onClick={() => setExpanded((open) => !open)}
              size="sm"
            />
          ) : null}
          {audio.canEdit ? (
            <>
              <IconButton
                label={`修改：${audio.title}`}
                name="edit"
                onClick={() => onEdit(audio)}
                size="sm"
              />
              <IconButton
                label={`移除：${audio.title}`}
                name="delete"
                onClick={() => onRemove(audio)}
                size="sm"
              />
            </>
          ) : null}
        </div>
      </div>
      {voice && expanded ? <TranscriptPanel audio={audio} /> : null}
    </li>
  )
}

/** 各子类的属性列；没填的留空。 */
function TraitCells({
  audio,
  audition,
  current,
}: {
  audio: ReferenceAudio
  audition: Audition
  current: boolean
}) {
  if (audio.audioKind === 'voice')
    return (
      <>
        <span className={WIDE_CELL}>{localeLabel(audio.locale)}</span>
        <span className={WIDE_CELL}>{voiceToneText(audio)}</span>
        <span className={WIDE_CELL}>{scenariosText(audio)}</span>
      </>
    )
  const waveform = (
    <span className="hidden min-w-0 @4xl:block">
      <RowWaveform audio={audio} audition={audition} current={current} />
    </span>
  )
  if (audio.audioKind === 'bgm')
    return (
      <>
        {waveform}
        <span className={WIDE_CELL}>{bgmStyleText(audio)}</span>
        <span className={cn(WIDE_CELL, 'text-right tabular-nums')}>{bpmText(audio)}</span>
      </>
    )
  return (
    <>
      {waveform}
      <span className={WIDE_CELL}>{sfxCategoryText(audio)}</span>
    </>
  )
}

/** 音色展开后的浅灰块：参考台词和上传人。 */
function TranscriptPanel({ audio }: { audio: ReferenceAudio }) {
  return (
    <div className="mr-3 mb-3 ml-18 rounded-sm bg-surface-container-low px-4 py-3">
      <div className="flex items-baseline justify-between gap-4 text-caption text-on-surface-faint">
        <span>{audio.transcript === null ? null : '参考台词'}</span>
        {audio.userName === null ? null : <span>上传人 {audio.userName}</span>}
      </div>
      {audio.transcript === null ? null : (
        <p className="mt-1.5 text-body-sm break-words whitespace-pre-wrap text-on-surface">
          {audio.transcript}
        </p>
      )}
    </div>
  )
}
