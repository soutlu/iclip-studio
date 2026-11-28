import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { AUDIO_FILTER_VALUES, type ReferenceAudio } from '@/shared/api/reference-audios'
import {
  AUDIO_FILTER_LABELS,
  AudioCover,
  AuditionBuffering,
  audioDurationText,
  type Audition,
} from '@/shared/ui/audition'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Input } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { NextPageFooter } from '@/shared/ui/list-state'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { RowClock } from './audio-card'
import type { LineVoice } from './composition/voices'
import { EmptyNote } from './empty-note'
import { useVoiceOptions } from './final-cut.api'
import { MediaRow, RowProgress, UsedBadge } from './media-row'
import {
  ORIGINAL_VOICE_NAME,
  voiceLocaleTag,
  voicePickerFilter,
  voiceTitleOf,
  type PickerGender,
  type PickerLocale,
  type VoiceControl,
  type VoiceLibrary,
} from './voice-choices'

const SEARCH_DEBOUNCE_MS = 300

/** 浮层左右离右栏可见区域两边的距离：和页签内容左右留的边（`--wf-tab-inset`）一样，浮层与内容边线对齐。 */
const PANEL_INSET = 14

const UNVOICED_NAME = '不配音'

const PICKER_LOCALES: readonly PickerLocale[] = [
  'all',
  ...AUDIO_FILTER_VALUES.locale.filter((each) => each !== 'none'),
  'none',
]

/** 语种分段列哪几项：「全部」加上资料库音色里实际有的语种（还没读到资料库时全列）。 */
const pickerLocalesOf = (library: readonly ReferenceAudio[] | undefined) => {
  if (library === undefined) return PICKER_LOCALES
  const present = new Set<PickerLocale>(library.map((audio) => audio.locale ?? 'none'))
  return PICKER_LOCALES.filter((each) => each === 'all' || present.has(each))
}

const localeTab = (locale: PickerLocale) =>
  locale === 'all' ? '全部' : voiceLocaleTag(locale === 'none' ? null : locale)

const PICKER_GENDERS: readonly { value: PickerGender; label: string }[] = [
  { value: 'all', label: '不限' },
  { value: 'female', label: AUDIO_FILTER_LABELS.gender.values.female },
  { value: 'male', label: AUDIO_FILTER_LABELS.gender.values.male },
]

/** 音色行名字下面那一行：「EN · 女声 · 社媒种草」，没填的那项不写。 */
const voiceDetail = (audio: ReferenceAudio) =>
  [
    voiceLocaleTag(audio.locale),
    audio.gender === null ? null : AUDIO_FILTER_LABELS.gender.values[audio.gender],
    ...audio.scenarios.map((each) => AUDIO_FILTER_LABELS.scenario.values[each]),
  ]
    .filter((each) => each !== null)
    .join(' · ')

/** 选音浮层给谁选：这种语言的默认音色，或某一句（`caption` 是字幕编号）。 */
export type VoicePickTarget = { target: 'language' } | { target: 'line'; caption: string }

/** 唤起一次选音浮层：给谁选、贴着哪个元素弹（浮层弹在它下面，左右仍与右栏内容边线对齐）。 */
export type VoicePickRequest = { pick: VoicePickTarget; anchor: HTMLElement }

type VoicePickerProps = {
  /** 这次唤起；null 时收起。 */
  request: VoicePickRequest | null
  /** 右栏页签内容的可见区域（滚动容器）：浮层左右与它的内容边线对齐。 */
  panel: HTMLElement | null
  /** 浮层挂在哪个元素下（编辑器根节点：样式、快捷键都在它里面）。 */
  container: HTMLElement | null
  voice: VoiceControl
  library: VoiceLibrary
  /** 右栏共用的试听：点封面试听样音，收起浮层时由调用方停下。 */
  audition: Audition
  onClose: () => void
}

/**
 * 同页选音浮层：在右栏内容区里贴着唤起它的按钮弹出，左右与内容边线对齐，盖住下面的列表、不动它的滚动位置；Esc、
 * 点外面、选定后收起。给单句选时最上面是「跟随默认（音色名）| 原片音色 | 不配音」；下面搜索框、语种和性别两组平铺
 * 分段，再下面音色列表（媒体行：封面试听、名字和「语种 · 性别 · 场景」、右边时长，悬停换成「选用」，生效的常驻
 * 「✓ 当前」）。给默认音色选时列表第一项是「原片音色」。选择都只记下（见 `VoiceControl`），不合成。
 */
export function VoicePicker({
  request,
  panel,
  container,
  voice,
  library,
  audition,
  onClose,
}: VoicePickerProps) {
  const anchor = request?.anchor ?? null
  // 浮层的锚：竖直方向是唤起它的按钮，左右是右栏可见区域去掉两边留白（浮层宽度跟着锚的宽度）
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          if (anchor === null || panel === null) return DOMRect.fromRect()
          const area = panel.getBoundingClientRect()
          const at = anchor.getBoundingClientRect()
          return DOMRect.fromRect({
            x: area.left + PANEL_INSET,
            y: at.top,
            width: Math.max(0, area.width - PANEL_INSET * 2),
            height: at.height,
          })
        },
      },
    }),
    [anchor, panel],
  )
  const pick = request?.pick ?? null
  return (
    <PopupRoot
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={request !== null}
    >
      <PopupAnchor virtualRef={virtualRef} />
      {pick === null ? null : (
        <PopupSurface
          align="start"
          aria-label={pick.target === 'line' ? '选择本句音色' : '选择默认音色'}
          className="wf-menu wf-voice-pop"
          collisionPadding={8}
          container={container}
          onCloseAutoFocus={(event) => {
            // 锚是量出来的位置，Radix 不知道把焦点还给谁：还给唤起它的按钮
            event.preventDefault()
            if (anchor?.isConnected === true) anchor.focus()
          }}
          onOpenAutoFocus={(event) => {
            // 打开后先落在搜索框上
            const search =
              event.currentTarget instanceof HTMLElement
                ? event.currentTarget.querySelector<HTMLElement>('input[type="search"]')
                : null
            if (search === null) return
            event.preventDefault()
            search.focus()
          }}
          side="bottom"
          sideOffset={6}
        >
          <VoicePickerBody
            audition={audition}
            key={pick.target === 'line' ? `line:${pick.caption}` : 'language'}
            library={library}
            onDone={onClose}
            pick={pick}
            voice={voice}
          />
        </PopupSurface>
      )}
    </PopupRoot>
  )
}

/** 单句最上面那排分段的取值：跟随默认、原片音色、不配音；自己选了资料库音色时三个都不按下。 */
const lineMode = (own: LineVoice | undefined) =>
  own === undefined
    ? 'follow'
    : 'dub' in own
      ? 'unvoiced'
      : own.voice === null
        ? 'original'
        : undefined

function VoicePickerBody({
  pick,
  voice,
  library,
  audition,
  onDone,
}: {
  pick: VoicePickTarget
  voice: VoiceControl
  library: VoiceLibrary
  audition: Audition
  onDone: () => void
}) {
  const [locale, setLocale] = useState<PickerLocale>('all')
  const [gender, setGender] = useState<PickerGender>('all')
  const [query, setQuery] = useState('')
  const [keyword, setKeyword] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  const options = useVoiceOptions(voicePickerFilter({ locale, gender, q: keyword }))
  const voices = options.data?.pages.flatMap((page) => page.items) ?? []
  const readFailed = options.isError && !options.isFetchNextPageError
  const listRef = useRef<HTMLUListElement>(null)
  const scroller = useCallback(() => listRef.current, [])

  const own = pick.target === 'line' ? voice.lines.get(pick.caption)?.own : undefined
  // 现在生效、要打「✓ 当前」的：默认音色在配音时是它（null 是原片音色）；单句是它自己选的资料库音色
  const picked =
    pick.target === 'language'
      ? voice.mode === 'dub'
        ? voice.voice
        : undefined
      : own !== undefined && 'voice' in own && own.voice !== null
        ? own.voice
        : undefined
  const choose = (id: string | null) => {
    if (id !== picked) {
      if (pick.target === 'language') voice.onVoice(id)
      else voice.onLine(pick.caption, { voice: id })
    }
    onDone()
  }
  // 原片音色只在给默认音色选、没搜也没筛时排在最前
  const showOriginal =
    pick.target === 'language' && keyword.trim() === '' && locale === 'all' && gender === 'all'
  const locales = pickerLocalesOf(library.voices)

  return (
    <div className="wf-voice-pop-body">
      {pick.target === 'line' ? (
        <LineModes
          defaultName={voice.mode === 'dub' ? voiceTitleOf(voice.voice, library.voices) : undefined}
          mode={lineMode(own)}
          onPick={(line) => {
            voice.onLine(pick.caption, line)
            onDone()
          }}
        />
      ) : null}
      <Input
        aria-label="搜索音色"
        leadingIcon="final-cut-search"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索音色名或描述"
        type="search"
        value={query}
        wrapperClassName="wf-field wf-search"
      />
      <div className="wf-voice-pop-filters">
        <ChipGroup
          aria-label="语种"
          className="wf-voice-pop-locales"
          onValueChange={(value) => {
            const next = locales.find((each) => each === value)
            if (next !== undefined) setLocale(next)
          }}
          type="single"
          value={locale}
          variant="segmented"
        >
          {locales.map((each) => (
            <FilterChip key={each} value={each} variant="segmented">
              {localeTab(each)}
            </FilterChip>
          ))}
        </ChipGroup>
        <ChipGroup
          aria-label="性别"
          onValueChange={(value) => {
            const next = PICKER_GENDERS.find((each) => each.value === value)
            if (next !== undefined) setGender(next.value)
          }}
          type="single"
          value={gender}
          variant="segmented"
        >
          {PICKER_GENDERS.map((each) => (
            <FilterChip key={each.value} value={each.value} variant="segmented">
              {each.label}
            </FilterChip>
          ))}
        </ChipGroup>
      </div>
      {library.problem === undefined ? null : (
        <InlineAlert
          action={{ label: '重试', onClick: library.problem.onRetry }}
          className="wf-voice-pop-alert"
          message={library.problem.message}
        />
      )}
      <ul aria-label="音色" className="wf-voice-pop-list" ref={listRef}>
        {showOriginal ? (
          <MediaRow
            badge={picked === null ? <UsedBadge>当前</UsedBadge> : undefined}
            cover={
              <AudioCover
                art="original"
                id="original"
                size="sm"
                state="idle"
                title={ORIGINAL_VOICE_NAME}
              />
            }
            current={picked === null}
            detail={<span className="wf-voice-detail">保留原片同期人声</span>}
            hit={
              <button
                aria-label={picked === null ? `${ORIGINAL_VOICE_NAME}，当前` : ORIGINAL_VOICE_NAME}
                className="wf-row-hit"
                onClick={() => choose(null)}
                type="button"
              />
            }
            title={ORIGINAL_VOICE_NAME}
          />
        ) : null}
        {voices.map((audio) => (
          <VoiceRow
            audio={audio}
            audition={audition}
            key={audio.id}
            onUse={() => choose(audio.id)}
            picked={audio.id === picked}
          />
        ))}
        {readFailed ? (
          <li className="wf-voice-pop-note">
            <InlineAlert
              action={{ label: '重试', onClick: () => void options.refetch() }}
              message={errorMessageOf(options.error, '读取音色失败')}
            />
          </li>
        ) : options.isPending ? (
          <li className="wf-voice-pop-note">
            <EmptyNote icon="final-cut-voice">正在读取音色…</EmptyNote>
          </li>
        ) : voices.length === 0 ? (
          <li className="wf-voice-pop-note">
            <EmptyNote icon="final-cut-voice">
              暂无符合条件的音色，请更换语种、性别或关键词
            </EmptyNote>
          </li>
        ) : options.hasNextPage ? (
          <li className="wf-voice-pop-note">
            {options.isFetchNextPageError && !options.isFetchingNextPage ? (
              <InlineAlert
                action={{ label: '重试', onClick: () => void options.fetchNextPage() }}
                message={errorMessageOf(options.error, '读取音色失败')}
              />
            ) : (
              <NextPageFooter getScrollElement={scroller} query={options} />
            )}
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/** 单句最上面一排：跟随默认音色（配音时写上它的名字）、原片音色、不配音；点了只记下这句的选择并收起。 */
function LineModes({
  defaultName,
  mode,
  onPick,
}: {
  defaultName: string | undefined
  mode: ReturnType<typeof lineMode>
  onPick: (line: LineVoice | null) => void
}) {
  const items = [
    {
      value: 'follow',
      label: defaultName === undefined ? '跟随默认' : `跟随默认（${defaultName}）`,
      line: null,
    },
    { value: 'original', label: ORIGINAL_VOICE_NAME, line: { voice: null } },
    { value: 'unvoiced', label: UNVOICED_NAME, line: { dub: false } },
  ] as const
  return (
    <ChipGroup
      aria-label="本句音色"
      onValueChange={(value) => {
        // 再点当前项报的是空值：照样当选了它（选完浮层收起）
        const item = items.find((each) => each.value === (value === '' ? mode : value))
        if (item !== undefined) onPick(item.line)
      }}
      type="single"
      // 单句选了资料库里的音色时三项都不选中
      value={mode ?? ''}
      variant="segmented"
    >
      {items.map((item) => (
        <FilterChip key={item.value} value={item.value} variant="segmented">
          <span className="wf-voice-pop-mode">{item.label}</span>
        </FilterChip>
      ))}
    </ChipGroup>
  )
}

/** 浮层里的一个资料库音色：封面点了试听 / 暂停，行内展开进度条；点行体或「选用」选它；生效的常驻「✓ 当前」。 */
function VoiceRow({
  audio,
  audition,
  picked,
  onUse,
}: {
  audio: ReferenceAudio
  audition: Audition
  picked: boolean
  onUse: () => void
}) {
  const current = audition.current === audio.id
  const playing = audition.playing === audio.id
  return (
    <MediaRow
      actions={
        picked ? undefined : (
          // 整行已能用 Enter 选用，「选用」不再占一个 Tab 停靠点
          <button className="wf-voice-use ui-state" onClick={onUse} tabIndex={-1} type="button">
            选用
          </button>
        )
      }
      badge={picked ? <UsedBadge>当前</UsedBadge> : undefined}
      cover={
        <AudioCover
          id={audio.id}
          onToggle={() => audition.toggle(audio.id, audio.url)}
          size="sm"
          state={playing ? 'playing' : current ? 'paused' : 'idle'}
          title={audio.title}
          traits={audio}
        >
          {current ? <AuditionBuffering audition={audition} /> : null}
        </AudioCover>
      }
      current={current || picked}
      detail={<span className="wf-voice-detail">{voiceDetail(audio)}</span>}
      end={
        picked ? undefined : current ? (
          <RowClock audition={audition} durationMs={audio.durationMs} />
        ) : (
          <span className="wf-media-duration">{audioDurationText(audio.durationMs)}</span>
        )
      }
      hit={
        <button
          aria-label={picked ? `${audio.title}，当前` : `选用：${audio.title}`}
          className="wf-row-hit"
          onClick={onUse}
          type="button"
        />
      }
      title={audio.title}
    >
      <RowProgress
        audition={audition}
        current={current}
        durationMs={audio.durationMs}
        label={`播放进度：${audio.title}`}
      />
    </MediaRow>
  )
}
