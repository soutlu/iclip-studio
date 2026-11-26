import { useEffect, useRef, useState } from 'react'
import { MEDIA_AUDIO_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  AuditionBuffering,
  AuditionButton,
  audioDurationText,
  useAuditionRatio,
  Waveform,
  type Audition,
} from '@/shared/ui/audition'
import { Button } from '@/shared/ui/button'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { measureLocalAudio, type LocalAudioLevels } from '../audio-peaks'

/** 试听本地选的文件时用的编号：和库里的条目共用一个试听，同一时间只放一条。 */
export const LOCAL_AUDITION_ID = 'local-audio-file'

export type PickedAudio = { file: File; url: string }

type AudioFileFieldProps = {
  picked: PickedAudio | null
  onFile: (file: File) => void
  audition: Audition
}

/** 添加时的文件区：没选时是能点、能拖进来的选择区；选了以后是一张能试听、带本地波形的卡。 */
export function AudioFileField({ picked, onFile, audition }: AudioFileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const drop = useFileDropTarget({
    blocked: false,
    onDirectory: () => {},
    onFiles: (files) => {
      const [first] = files
      if (first !== undefined) onFile(first)
    },
  })
  const choose = () => inputRef.current?.click()
  return (
    <div {...drop.dragHandlers}>
      <input
        accept={MEDIA_AUDIO_ACCEPT}
        aria-label="选择音频文件"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (file !== undefined) onFile(file)
          event.currentTarget.value = ''
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      {picked === null ? (
        <button
          className={cn(
            'flex w-full ui-state cursor-pointer flex-col items-center gap-1.5 rounded-md bg-surface-container-low px-4 py-6 text-body-sm text-on-surface-variant ui-focus',
            drop.dragOver && 'bg-state-active',
          )}
          onClick={choose}
          type="button"
        >
          <Icon decorative name="upload" size="lg" />
          {drop.dragOver ? '松开添加音频' : '点击选择或拖入音频文件'}
        </button>
      ) : (
        <PickedCard
          audition={audition}
          key={picked.url}
          onReplace={choose}
          picked={picked}
          replacing={drop.dragOver}
        />
      )}
    </div>
  )
}

function PickedCard({
  picked,
  audition,
  onReplace,
  replacing,
}: {
  picked: PickedAudio
  audition: Audition
  onReplace: () => void
  replacing: boolean
}) {
  const [levels, setLevels] = useState<LocalAudioLevels | null>(null)
  useEffect(() => {
    let cancelled = false
    void measureLocalAudio(picked.file).then((measured) => {
      if (!cancelled) setLevels(measured)
    })
    return () => {
      cancelled = true
    }
  }, [picked.file])
  const current = audition.current === LOCAL_AUDITION_ID
  const playing = audition.playing === LOCAL_AUDITION_ID
  const name = picked.file.name
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md bg-surface-container-lowest px-3 py-3 ring-1 ring-hairline',
        replacing && 'bg-state-active',
      )}
    >
      <AuditionButton
        label={playing ? `暂停试听：${name}` : `试听：${name}`}
        onToggle={() => audition.toggle(LOCAL_AUDITION_ID, picked.url)}
        playing={playing}
      >
        {current ? <AuditionBuffering audition={audition} /> : null}
      </AuditionButton>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-body-sm font-medium text-on-surface" title={name}>
            {name}
          </p>
          {levels === null ? null : (
            <span className="shrink-0 text-caption text-on-surface-faint tabular-nums">
              {audioDurationText(levels.durationMs)}
            </span>
          )}
        </div>
        {levels === null ? null : current ? (
          <PlayingWaveform audition={audition} levels={levels} />
        ) : (
          <Waveform className="mt-1 h-5" peaks={levels.peaks} />
        )}
      </div>
      <Button onClick={onReplace} size="md" variant="ghost">
        更换
      </Button>
    </div>
  )
}

function PlayingWaveform({ audition, levels }: { audition: Audition; levels: LocalAudioLevels }) {
  const { ratio } = useAuditionRatio(audition, levels.durationMs)
  return <Waveform className="mt-1 h-5" peaks={levels.peaks} progress={ratio} />
}
