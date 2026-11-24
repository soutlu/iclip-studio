import { useId, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_AUDIO_ACCEPT, uploadContentTypeOf } from '@/shared/api/media-upload'
import {
  AUDIO_KINDS,
  AUDIO_LOCALES,
  type AudioKind,
  type AudioLocale,
  type ReferenceAudio,
} from '@/shared/api/reference-audios'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { useAudition } from '@/shared/ui/audition'
import { Button, IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input, Select, Textarea } from '@/shared/ui/field'
import { ListEmpty, ListError, ListPending, NextPageFooter } from '@/shared/ui/list-state'
import { toast } from '@/shared/ui/toast'
import {
  useAddReferenceAudio,
  useReferenceAudioFilters,
  useReferenceAudios,
  useRemoveReferenceAudio,
  useUpdateReferenceAudio,
  type ReferenceAudioChange,
  type ReferenceAudioDraft,
  type ReferenceAudioScope,
} from '../reference-audios.api'
import { LibraryPageHeader } from './library-page-header'
import { useLibraryPageScroll } from './library-page-scroll'
import { LibraryPageShell } from './library-page-shell'

const KIND_LABELS: Readonly<Record<AudioKind, string>> = {
  voice: '音色',
  bgm: '配乐',
  sfx: '音效',
}

const LOCALE_NAMES: Readonly<Record<AudioLocale, string>> = {
  zh: '中文',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
}

const MAX_TITLE_CHARS = 200
const MAX_TEXT_CHARS = 2000

// 音频照音频上传的规则收，格式名从它的可选类型里取
const FORMAT_NAMES = MEDIA_AUDIO_ACCEPT.split(',')
  .filter((each) => each.startsWith('.'))
  .map((each) => each.slice(1).toUpperCase())

const FORMATS_TEXT = `${FORMAT_NAMES.slice(0, -1).join('、')} 或 ${FORMAT_NAMES.at(-1) ?? ''}`

const durationText = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; audio: ReferenceAudio }
  | { kind: 'remove'; audio: ReferenceAudio }
  | null

type ReferenceAudiosRouteProps = {
  tabs: ReactNode
  scope: ReferenceAudioScope
  onScopeChange: (next: ReferenceAudioScope) => void
}

/**
 * 资料库的「音频库」：音色、配乐与音效，建立晚的在前，按子类筛、按关键词搜（标题、备注与台词），往下滚接着读。
 * 每行能试听（同一时间只放一条，切走时停下）；能上传的人可以添加，属主或治理者（`canEdit`）可以改、移除。
 */
export function ReferenceAudiosRoute({ tabs, scope, onScopeChange }: ReferenceAudiosRouteProps) {
  const { mainRef, getScrollElement } = useLibraryPageScroll()
  const { data: user } = useUser()
  const canAdd = hasPermission(user, PERMISSION.uploadsWrite)
  const audios = useReferenceAudios(scope)
  const filters = useReferenceAudioFilters()
  const [dialog, setDialog] = useState<Dialog>(null)
  // 切到别的页签时这一页卸掉，试听跟着停
  const { playing, toggle } = useAudition({
    active: true,
    onError: () => toast.error('音频试听失败，请重试'),
  })
  const items = audios.data?.pages.flatMap((page) => page.items) ?? []
  const total = audios.data?.pages[0]?.total ?? undefined
  const filtered = scope.audioKind !== null || scope.q.trim() !== ''
  const listError = audios.isError && !audios.isFetchNextPageError
  const countOf = (kind: AudioKind) =>
    filters.data?.audioKinds.find((each) => each.audioKind === kind)?.count
  const allCount = filters.data?.audioKinds.reduce((sum, each) => sum + each.count, 0)
  const close = () => setDialog(null)

  return (
    <LibraryPageShell
      attachments={
        <DialogRoot
          onOpenChange={(open) => {
            if (!open) close()
          }}
          open={dialog !== null}
        >
          {dialog === null ? null : dialog.kind === 'add' ? (
            <AddAudioDialog initialKind={scope.audioKind} onDone={close} />
          ) : dialog.kind === 'edit' ? (
            <EditAudioDialog audio={dialog.audio} key={dialog.audio.id} onDone={close} />
          ) : (
            <RemoveAudioDialog audio={dialog.audio} onDone={close} />
          )}
        </DialogRoot>
      }
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <ChipGroup
            aria-label="音频类型"
            onValueChange={(value) => {
              if (value === '') return
              const kind = AUDIO_KINDS.find((each) => each === value) ?? null
              onScopeChange({ ...scope, audioKind: kind })
            }}
            type="single"
            value={scope.audioKind ?? 'all'}
          >
            <FilterChip value="all">
              全部{allCount === undefined ? null : <ChipCount count={allCount} />}
            </FilterChip>
            {AUDIO_KINDS.map((kind) => {
              const count = countOf(kind)
              return (
                <FilterChip key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                  {count === undefined ? null : <ChipCount count={count} />}
                </FilterChip>
              )
            })}
          </ChipGroup>
          {total === undefined ? null : (
            <span className="ml-auto pl-2 text-body-sm text-on-surface-faint">
              {filtered ? `找到 ${String(total)} 条` : `共 ${String(total)} 条`}
            </span>
          )}
        </div>
      }
      header={
        <LibraryPageHeader
          action={
            canAdd ? (
              <Button
                className="h-(--control-height-xl) shrink-0 rounded-full"
                leadingIcon="add"
                onClick={() => setDialog({ kind: 'add' })}
                variant="inverted"
              >
                添加音频
              </Button>
            ) : undefined
          }
          description="收录音色、配乐与音效。音色用于 final-cut 的 AI 配音，配乐与音效可加入 final-cut 的时间线。"
          search={{
            label: '搜索音频',
            onSearch: (q) => onScopeChange({ ...scope, q }),
            placeholder: '搜索标题、备注、台词…',
            value: scope.q,
          }}
          tabs={tabs}
        />
      }
      label="资料库"
      mainRef={mainRef}
    >
      {audios.isPending ? (
        <ListPending label="正在读取音频" />
      ) : listError ? (
        <ListError
          message={errorMessageOf(audios.error, '读取音频库失败')}
          onRetry={() => void audios.refetch()}
        />
      ) : items.length === 0 ? (
        <ListEmpty icon="waveform">
          {filtered
            ? '暂无匹配的音频，请更换关键词或清除筛选'
            : canAdd
              ? '暂无音频，请点击「添加音频」'
              : '暂无音频'}
        </ListEmpty>
      ) : (
        <ul aria-label="音频" className="flex flex-col gap-2">
          {items.map((audio) => (
            <AudioRow
              audio={audio}
              key={audio.id}
              onEdit={() => setDialog({ kind: 'edit', audio })}
              onRemove={() => setDialog({ kind: 'remove', audio })}
              onToggle={() => toggle(audio.id, audio.url)}
              playing={playing === audio.id}
            />
          ))}
        </ul>
      )}
      {audios.hasNextPage ? (
        audios.isFetchNextPageError && !audios.isFetchingNextPage ? (
          <ListError
            message={errorMessageOf(audios.error, '读取音频库失败')}
            onRetry={() => void audios.fetchNextPage()}
          />
        ) : (
          <NextPageFooter
            getScrollElement={getScrollElement}
            query={audios}
            shown={items.length}
            total={total}
          />
        )
      ) : null}
    </LibraryPageShell>
  )
}

function ChipCount({ count }: { count: number }) {
  return <span className="text-on-surface-faint tabular-nums">{count}</span>
}

function AudioRow({
  audio,
  playing,
  onToggle,
  onEdit,
  onRemove,
}: {
  audio: ReferenceAudio
  playing: boolean
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const meta = [
    KIND_LABELS[audio.audioKind],
    audio.locale === null ? null : LOCALE_NAMES[audio.locale],
    durationText(audio.durationMs),
    audio.userName,
  ].filter((part) => part !== null)
  return (
    <li className="flex items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-3">
      <IconButton
        aria-pressed={playing}
        className="shrink-0 rounded-full bg-surface-container-high text-on-surface"
        label={playing ? `暂停试听：${audio.title}` : `试听：${audio.title}`}
        name={playing ? 'pause' : 'play'}
        onClick={onToggle}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-on-surface" title={audio.title}>
          {audio.title}
        </p>
        <p className="truncate text-body-sm text-on-surface-variant">{meta.join(' · ')}</p>
        {audio.description === null ? null : (
          <p className="line-clamp-2 text-body-sm break-words text-on-surface-faint">
            {audio.description}
          </p>
        )}
      </div>
      {audio.canEdit ? (
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={`修改：${audio.title}`} name="edit" onClick={onEdit} size="md" />
          <IconButton label={`移除：${audio.title}`} name="delete" onClick={onRemove} size="md" />
        </div>
      ) : null}
    </li>
  )
}

/** 音色才有的两项：语种（可以不选）和台词。 */
function VoiceFields({
  locale,
  transcript,
  onLocale,
  onTranscript,
}: {
  locale: AudioLocale | null
  transcript: string
  onLocale: (locale: AudioLocale | null) => void
  onTranscript: (text: string) => void
}) {
  return (
    <>
      <Select
        aria-label="语种"
        onChange={(event) =>
          onLocale(AUDIO_LOCALES.find((each) => each === event.target.value) ?? null)
        }
        value={locale ?? ''}
      >
        <option value="">不限语种</option>
        {AUDIO_LOCALES.map((each) => (
          <option key={each} value={each}>
            {LOCALE_NAMES[each]}
          </option>
        ))}
      </Select>
      <Textarea
        aria-label="台词"
        maxLength={MAX_TEXT_CHARS}
        onChange={(event) => onTranscript(event.target.value)}
        placeholder="该音色音频中的台词文本（选填）"
        rows={2}
        value={transcript}
      />
    </>
  )
}

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

function AddAudioDialog({
  initialKind,
  onDone,
}: {
  initialKind: AudioKind | null
  onDone: () => void
}) {
  const add = useAddReferenceAudio()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<AudioKind | null>(initialKind)
  const [file, setFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [locale, setLocale] = useState<AudioLocale | null>(null)
  const [transcript, setTranscript] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const trimmed = title.trim()
  const pickFile = (picked: File | undefined) => {
    if (picked === undefined) return
    if (uploadContentTypeOf(picked, 'audio') === undefined) {
      setFile(null)
      setProblem(`文件格式不受支持，无法添加；请选择 ${FORMATS_TEXT} 音频`)
      return
    }
    setFile(picked)
    setProblem(null)
    if (trimmed === '') setTitle(picked.name.replace(/\.[^.]+$/, '').slice(0, MAX_TITLE_CHARS))
  }
  const submit = () => {
    if (trimmed === '' || kind === null || file === null || add.isPending) return
    const note = description.trim()
    const words = transcript.trim()
    const draft: ReferenceAudioDraft = {
      audioKind: kind,
      title: trimmed,
      ...(note === '' ? {} : { description: note }),
      ...(kind === 'voice' && locale !== null ? { locale } : {}),
      ...(kind === 'voice' && words !== '' ? { transcript: words } : {}),
    }
    setProblem(null)
    add.mutate(
      { draft, file },
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
      <DialogBody className="flex flex-col gap-3 px-6 pt-2.5 pb-6">
        <ChipGroup
          aria-label="类型"
          onValueChange={(value) => {
            const next = AUDIO_KINDS.find((each) => each === value)
            if (next !== undefined) setKind(next)
          }}
          type="single"
          value={kind ?? ''}
        >
          {AUDIO_KINDS.map((each) => (
            <FilterChip key={each} value={each}>
              {KIND_LABELS[each]}
            </FilterChip>
          ))}
        </ChipGroup>
        <input
          accept={MEDIA_AUDIO_ACCEPT}
          aria-label="选择音频文件"
          className="hidden"
          onChange={(event) => {
            pickFile(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
          ref={fileRef}
          tabIndex={-1}
          type="file"
        />
        <div className="flex items-center gap-3">
          <Button
            aria-describedby={hintId}
            leadingIcon="upload"
            onClick={() => fileRef.current?.click()}
            variant="outlined"
          >
            {file === null ? '选择音频' : '更换音频'}
          </Button>
          <span className="min-w-0 truncate text-body-sm text-on-surface" title={file?.name}>
            {file?.name}
          </span>
        </div>
        <p className="text-body-sm text-on-surface-variant" id={hintId}>
          支持 {FORMATS_TEXT}；音色需 3 到 30 秒
        </p>
        <Input
          aria-label="标题"
          maxLength={MAX_TITLE_CHARS}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="输入标题"
          value={title}
        />
        {kind === 'voice' ? (
          <VoiceFields
            locale={locale}
            onLocale={setLocale}
            onTranscript={setTranscript}
            transcript={transcript}
          />
        ) : null}
        <Textarea
          aria-label="备注"
          maxLength={MAX_TEXT_CHARS}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="备注（可不填）"
          rows={2}
          value={description}
        />
        {problem === null ? null : (
          <p className="text-body-sm text-error" role="alert">
            {problem}
          </p>
        )}
      </DialogBody>
      <DialogActions
        disabled={trimmed === '' || kind === null || file === null}
        loading={add.isPending}
        onCancel={onDone}
        onSubmit={submit}
        submitLabel="添加"
      />
    </DialogSurface>
  )
}

/** 改了的才写进去；清空了的写 null。 */
const changedText = (draft: string, saved: string | null): string | null | undefined => {
  const text = draft.trim()
  if (text === (saved ?? '')) return undefined
  return text === '' ? null : text
}

function EditAudioDialog({ audio, onDone }: { audio: ReferenceAudio; onDone: () => void }) {
  const update = useUpdateReferenceAudio()
  const [title, setTitle] = useState(audio.title)
  const [description, setDescription] = useState(audio.description ?? '')
  const [locale, setLocale] = useState<AudioLocale | null>(audio.locale)
  const [transcript, setTranscript] = useState(audio.transcript ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const voice = audio.audioKind === 'voice'
  const trimmed = title.trim()
  const note = changedText(description, audio.description)
  const words = voice ? changedText(transcript, audio.transcript) : undefined
  const change: ReferenceAudioChange = {
    ...(trimmed === audio.title ? {} : { title: trimmed }),
    ...(note === undefined ? {} : { description: note }),
    ...(voice && locale !== audio.locale ? { locale } : {}),
    ...(words === undefined ? {} : { transcript: words }),
  }
  const unchanged = Object.keys(change).length === 0
  const submit = () => {
    if (trimmed === '' || unchanged || update.isPending) return
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
      <DialogBody className="flex flex-col gap-3 px-6 pt-2.5 pb-6">
        <Input
          aria-label="标题"
          maxLength={MAX_TITLE_CHARS}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="输入标题"
          value={title}
        />
        {voice ? (
          <VoiceFields
            locale={locale}
            onLocale={setLocale}
            onTranscript={setTranscript}
            transcript={transcript}
          />
        ) : null}
        <Textarea
          aria-label="备注"
          maxLength={MAX_TEXT_CHARS}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="备注（可不填）"
          rows={2}
          value={description}
        />
        {problem === null ? null : (
          <p className="text-body-sm text-error" role="alert">
            {problem}
          </p>
        )}
      </DialogBody>
      <DialogActions
        disabled={trimmed === '' || unchanged}
        loading={update.isPending}
        onCancel={onDone}
        onSubmit={submit}
        submitLabel="保存"
      />
    </DialogSurface>
  )
}

function RemoveAudioDialog({ audio, onDone }: { audio: ReferenceAudio; onDone: () => void }) {
  const remove = useRemoveReferenceAudio()
  return (
    <DialogSurface aria-describedby={undefined} aria-label={`移除「${audio.title}」`}>
      <DialogHeader closeLabel="关闭移除确认" title={`移除「${audio.title}」`} />
      <DialogBody className="flex flex-col gap-3 px-6 pt-2.5 pb-6">
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
