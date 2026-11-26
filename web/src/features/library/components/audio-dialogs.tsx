import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_AUDIO_ACCEPT, uploadContentTypeOf } from '@/shared/api/media-upload'
import { AUDIO_KINDS, type AudioKind, type ReferenceAudio } from '@/shared/api/reference-audios'
import { AUDIO_KIND_LABELS, type Audition } from '@/shared/ui/audition'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DialogBody, DialogFooter, DialogHeader, DialogSurface } from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import {
  audioChangeOf,
  audioDraftOf,
  audioFormOf,
  bpmOf,
  emptyAudioForm,
  MAX_TITLE_CHARS,
  type AudioFormValues,
} from '../audio-form'
import {
  useAddReferenceAudio,
  useRemoveReferenceAudio,
  useUpdateReferenceAudio,
} from '../reference-audios.api'
import { AudioFileField, LOCAL_AUDITION_ID, type PickedAudio } from './audio-file-field'
import { AudioDetailsFields } from './audio-form-fields'

// 音频照音频上传的规则收，格式名从它的可选类型里取
const FORMAT_NAMES = MEDIA_AUDIO_ACCEPT.split(',')
  .filter((each) => each.startsWith('.'))
  .map((each) => each.slice(1).toUpperCase())

const BODY_CLASS = 'flex flex-col gap-4 px-6 pt-2.5 pb-6'

function DialogActions({
  submitLabel,
  disabled,
  loading,
  onCancel,
  onSubmit,
}: {
  submitLabel: string
  disabled: boolean
  loading: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <DialogFooter>
      <span />
      <div className="flex gap-2">
        <Button className="min-w-[74px]" onClick={onCancel} variant="outlined">
          取消
        </Button>
        <Button className="min-w-[74px]" disabled={disabled} loading={loading} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </DialogFooter>
  )
}

function Problem({ text }: { text: string | null }) {
  return text === null ? null : (
    <p className="text-body-sm text-error" role="alert">
      {text}
    </p>
  )
}

/** 填得能提交：名称不空，节奏要么不填、要么在范围内。 */
const completeOf = (values: AudioFormValues) =>
  values.title.trim() !== '' && (values.kind !== 'bgm' || bpmOf(values.bpm) !== undefined)

export function AddAudioDialog({
  initialKind,
  audition,
  onDone,
}: {
  initialKind: AudioKind
  audition: Audition
  onDone: () => void
}) {
  const add = useAddReferenceAudio()
  const [values, setValues] = useState(() => emptyAudioForm(initialKind))
  const [picked, setPicked] = useState<PickedAudio | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // 本地试听用的地址在换文件、关弹窗时收回
  const urlRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )
  const change = (patch: Partial<AudioFormValues>) => setValues((prev) => ({ ...prev, ...patch }))
  const pickFile = (file: File) => {
    if (uploadContentTypeOf(file, 'audio') === undefined) {
      setProblem(
        `文件格式不受支持，无法添加；请选择 ${FORMAT_NAMES.slice(0, -1).join('、')} 或 ${FORMAT_NAMES.at(-1) ?? ''} 音频`,
      )
      return
    }
    if (audition.current === LOCAL_AUDITION_ID) audition.stop()
    if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(file)
    urlRef.current = url
    setPicked({ file, url })
    setProblem(null)
    if (values.title.trim() === '')
      change({ title: file.name.replace(/\.[^.]+$/, '').slice(0, MAX_TITLE_CHARS) })
  }
  const ready = picked !== null && completeOf(values)
  const submit = () => {
    if (picked === null || !ready || add.isPending) return
    setProblem(null)
    add.mutate(
      { draft: audioDraftOf(values), file: picked.file },
      {
        onError: (error) => setProblem(errorMessageOf(error, '添加失败，请重试')),
        onSuccess: () => {
          toast.success('已添加')
          onDone()
        },
      },
    )
  }
  return (
    <DialogSurface aria-describedby={undefined} aria-label="添加音频">
      <DialogHeader closeLabel="关闭" title="添加音频" />
      <DialogBody className={BODY_CLASS}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ChipGroup
            aria-label="类型"
            onValueChange={(value) => {
              const kind = AUDIO_KINDS.find((each) => each === value)
              if (kind !== undefined) change({ kind })
            }}
            type="single"
            value={values.kind}
            variant="segmented"
          >
            {AUDIO_KINDS.map((kind) => (
              <FilterChip className="px-3.5" key={kind} value={kind} variant="segmented">
                {AUDIO_KIND_LABELS[kind]}
              </FilterChip>
            ))}
          </ChipGroup>
          <span className="text-caption text-on-surface-faint">
            支持 {FORMAT_NAMES.join(' / ')}
            {values.kind === 'voice' ? ' · 音色需 3 至 30 秒' : null}
          </span>
        </div>
        <AudioFileField audition={audition} onFile={pickFile} picked={picked} />
        <AudioDetailsFields onChange={change} values={values} />
        <Problem text={problem} />
      </DialogBody>
      <DialogActions
        disabled={!ready}
        loading={add.isPending}
        onCancel={onDone}
        onSubmit={submit}
        submitLabel="添加"
      />
    </DialogSurface>
  )
}

export function EditAudioDialog({ audio, onDone }: { audio: ReferenceAudio; onDone: () => void }) {
  const update = useUpdateReferenceAudio()
  const [values, setValues] = useState(() => audioFormOf(audio))
  const [problem, setProblem] = useState<string | null>(null)
  const change = audioChangeOf(values, audio)
  const ready = completeOf(values) && Object.keys(change).length > 0
  const submit = () => {
    if (!ready || update.isPending) return
    setProblem(null)
    update.mutate(
      { audio, change },
      {
        onError: (error) => setProblem(errorMessageOf(error, '保存失败，请重试')),
        onSuccess: () => {
          toast.success('已保存')
          onDone()
        },
      },
    )
  }
  return (
    <DialogSurface aria-describedby={undefined} aria-label={`修改「${audio.title}」`}>
      <DialogHeader closeLabel="关闭" title={`修改「${audio.title}」`} />
      <DialogBody className={BODY_CLASS}>
        <AudioDetailsFields
          onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
          values={values}
        />
        <Problem text={problem} />
      </DialogBody>
      <DialogActions
        disabled={!ready}
        loading={update.isPending}
        onCancel={onDone}
        onSubmit={submit}
        submitLabel="保存"
      />
    </DialogSurface>
  )
}

export function RemoveAudioDialog({
  audio,
  onDone,
}: {
  audio: ReferenceAudio
  onDone: () => void
}) {
  const remove = useRemoveReferenceAudio()
  return (
    <DialogSurface aria-describedby={undefined} aria-label={`移除「${audio.title}」`}>
      <DialogHeader closeLabel="关闭移除确认" title={`移除「${audio.title}」`} />
      <DialogBody className={BODY_CLASS}>
        <p className="text-body leading-relaxed text-on-surface-variant">
          移除后该音频不再出现在资料库中，final-cut 里已经用到的配音、配乐和音效不受影响
        </p>
      </DialogBody>
      <DialogActions
        disabled={false}
        loading={remove.isPending}
        onCancel={onDone}
        onSubmit={() =>
          remove.mutate(audio, {
            onError: (error) => toast.error(errorMessageOf(error, '移除失败，请重试')),
            onSuccess: () => {
              toast.success('已从资料库移除')
              onDone()
            },
          })
        }
        submitLabel="移除"
      />
    </DialogSurface>
  )
}
