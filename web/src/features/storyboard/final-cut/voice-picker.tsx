import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import {
  AUDIO_FILTER_VALUES,
  type AudioTraitFilter,
  type ReferenceAudio,
} from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  AUDIO_FILTER_LABELS,
  AudioCover,
  AuditionBuffering,
  AuditionProgressLine,
  audioDurationText,
  voiceTraitsText,
  type Audition,
} from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { NextPageFooter } from '@/shared/ui/list-state'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { BlockedReason } from '../components/blocked-reason'
import { AudioCardText } from './audio-card'
import { EmptyNote } from './empty-note'
import { useVoiceOptions } from './final-cut.api'
import { SOURCE_LOCALE, type Language } from './locales'
import { TraitFilters } from './trait-filters'
import {
  languageChoice,
  ownLineVoice,
  PICKER_TRAITS,
  voiceBusy,
  voiceLocaleTag,
  voicePickerFilter,
  type PickerLocale,
  type VoiceControl,
} from './voice-choices'

const SEARCH_DEBOUNCE_MS = 300

const PICKER_LOCALES: readonly PickerLocale[] = [
  ...AUDIO_FILTER_VALUES.locale.filter((each) => each !== 'none'),
  'none',
  'all',
]

const localeName = (locale: PickerLocale) =>
  locale === 'all' ? '全部' : AUDIO_FILTER_LABELS.locale.values[locale]

const localeTag = (locale: PickerLocale) =>
  locale === 'all' ? '全部' : voiceLocaleTag(locale === 'none' ? null : locale)

/** 顶行「原声」按钮：选它是用原声（整体音色或这一句）；`pressed` 是现在用的就是原声。 */
type OriginalChoice = { pressed: boolean; blocked: string | undefined; onUse: () => void }

type VoicePickerProps = {
  /** 「选择音色」「选择本句音色」等。 */
  title: string
  /** 语种下拉一开始选哪项。 */
  defaultLocale: PickerLocale
  /** 正在用着的音色（打 ✓、不给「选用」）；用的是原声或还没选时传 null。 */
  picked: string | null
  /** 不给时顶行没有「原声」（旁白必须用资料库音色）。 */
  original: OriginalChoice | undefined
  /** 选用 `id` 不行时的原因（照 `BlockedReason` 说明）。 */
  blockedFor: (id: string) => string | undefined
  onUse: (audio: ReferenceAudio) => void
  onBack: () => void
  audition: Audition
  /** 点卡片试听或暂停。 */
  onToggle: (audio: ReferenceAudio) => void
}

/**
 * 选音面板：「字幕」页签里的一层（不是弹窗），顶行返回、语种下拉和「原声」，下面搜索、按场景 / 性别 / 年龄筛（每项选一个），
 * 列表从服务端按条件查、往下滚接着读。点卡片试听，右边「选用」（悬停、聚焦或正在试听时露出）；用着的那张打 ✓。
 */
function VoicePicker({
  title,
  defaultLocale,
  picked,
  original,
  blockedFor,
  onUse,
  onBack,
  audition,
  onToggle,
}: VoicePickerProps) {
  const [locale, setLocale] = useState<PickerLocale>(defaultLocale)
  const [query, setQuery] = useState('')
  const [keyword, setKeyword] = useState('')
  const [traits, setTraits] = useState<AudioTraitFilter>({})
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  const options = useVoiceOptions(voicePickerFilter({ locale, q: keyword, traits }))
  const voices = options.data?.pages.flatMap((page) => page.items) ?? []
  const total = options.data?.pages[0]?.total
  const readFailed = options.isError && !options.isFetchNextPageError
  const listRef = useRef<HTMLUListElement>(null)
  const scroller = useCallback(() => listRef.current, [])
  // 点「更换」的按钮跟着首页藏起来了：焦点放到「返回」上，别掉出编辑器（编辑器的快捷键只在焦点在里面时生效）
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => backRef.current?.focus(), [])

  return (
    <section aria-label={title} className="wf-voice-picker">
      <div className="wf-voice-picker-head">
        <IconButton
          className="wf-voice-back"
          label="返回"
          name="final-cut-disclosure"
          onClick={onBack}
          ref={backRef}
          size="xs"
        />
        <h3 className="wf-voice-picker-title">{title}</h3>
        <MenuRoot>
          <MenuTrigger asChild>
            <button
              aria-label={`语种：${localeName(locale)}`}
              className="wf-voice-locale ui-state ui-focus"
              type="button"
            >
              {localeTag(locale)}
              <Icon decorative name="final-cut-expand" size="xs" />
            </button>
          </MenuTrigger>
          <MenuSurface align="end" className="wf-menu">
            <MenuRadioGroup
              onValueChange={(value) => {
                const next = PICKER_LOCALES.find((each) => each === value)
                if (next !== undefined) setLocale(next)
              }}
              value={locale}
            >
              {PICKER_LOCALES.map((each) => (
                <MenuRadioItem key={each} value={each}>
                  {localeName(each)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>
        {original === undefined ? null : (
          <BlockedReason reason={original.blocked}>
            <button
              aria-disabled={original.blocked === undefined ? undefined : true}
              aria-pressed={original.pressed}
              className="wf-chip-btn ui-state ui-focus"
              onClick={() => {
                if (original.blocked === undefined) original.onUse()
              }}
              type="button"
            >
              原声
            </button>
          </BlockedReason>
        )}
      </div>
      <Input
        aria-label="搜索音色"
        leadingIcon="final-cut-search"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索音色名、风格…"
        type="search"
        value={query}
        wrapperClassName="wf-field wf-search wf-voice-search"
      />
      <TraitFilters keys={PICKER_TRAITS} onChange={setTraits} total={total} value={traits} />
      {readFailed ? (
        <InlineAlert
          action={{ label: '重试', onClick: () => void options.refetch() }}
          className="wf-voice-picker-alert"
          message={errorMessageOf(options.error, '读取音色失败')}
        />
      ) : options.isPending ? (
        <EmptyNote icon="final-cut-voice">正在读取音色…</EmptyNote>
      ) : voices.length === 0 ? (
        <EmptyNote icon="final-cut-voice">
          暂无符合条件的音色，请更换语种、关键词或筛选条件
        </EmptyNote>
      ) : (
        <ul aria-label="音色" className="wf-tab-list wf-voice-options" ref={listRef}>
          {voices.map((voice) => (
            <VoiceOption
              audition={audition}
              blocked={blockedFor(voice.id)}
              key={voice.id}
              onToggle={() => onToggle(voice)}
              onUse={() => onUse(voice)}
              picked={voice.id === picked}
              voice={voice}
            />
          ))}
          {options.hasNextPage ? (
            <li className="wf-audio-more">
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
      )}
    </section>
  )
}

/** 选音面板给谁选：这种语言的整体音色、某一句（`caption`）或原文的旁白。 */
export type VoicePick =
  { target: 'language' } | { target: 'line'; caption: string } | { target: 'narration' }

type TargetVoicePickerProps = {
  pick: VoicePick
  /** 当前展示语言：整体音色和单句的语种下拉默认它。 */
  locale: Language
  /** 译文语言下的人声配置；给整体音色、单句选时要有。 */
  voice: VoiceControl | undefined
  /** 旁白现在要用的音色。 */
  narrationVoice: string | null
  onNarrationVoice: (id: string) => void
  /** 选用或返回：回到「字幕」页签首页。 */
  onDone: () => void
  audition: Audition
  onToggle: (audio: ReferenceAudio) => void
}

/**
 * 按选给谁配好选音面板：整体音色照人声卡常用音色的规则（`languageChoice`）选；单句照单句菜单的规则只改这一句（`onLine`），
 * 「原声」是这句用原声；旁白只换旁白要用的音色，没有「原声」，语种默认「全部」。选用后都回到首页。
 */
export function TargetVoicePicker({
  pick,
  locale,
  voice,
  narrationVoice,
  onNarrationVoice,
  onDone,
  audition,
  onToggle,
}: TargetVoicePickerProps) {
  const shared = { audition, onToggle, onBack: onDone }
  const defaultLocale: PickerLocale = locale === SOURCE_LOCALE ? 'all' : locale
  if (pick.target === 'narration')
    return (
      <VoicePicker
        {...shared}
        blockedFor={() => undefined}
        defaultLocale="all"
        onUse={(audio) => {
          onNarrationVoice(audio.id)
          onDone()
        }}
        original={undefined}
        picked={narrationVoice}
        title="选择旁白音色"
      />
    )
  if (voice === undefined) return null
  if (pick.target === 'line') {
    const { caption } = pick
    const own = ownLineVoice(voice, caption)
    const blocked = voiceBusy(voice) ?? voice.lineBlocked.get(caption)
    const ownOriginal = own !== undefined && 'voice' in own && own.voice === null
    return (
      <VoicePicker
        {...shared}
        blockedFor={() => blocked}
        defaultLocale={defaultLocale}
        onUse={(audio) => {
          voice.onLine(caption, { voice: audio.id })
          onDone()
        }}
        original={{
          pressed: ownOriginal,
          blocked,
          onUse: () => {
            if (!ownOriginal) voice.onLine(caption, { voice: null })
            onDone()
          },
        }}
        picked={own !== undefined && 'voice' in own ? own.voice : null}
        title="选择本句音色"
      />
    )
  }
  const original = languageChoice(voice, null)
  return (
    <VoicePicker
      {...shared}
      blockedFor={(id) => languageChoice(voice, id).blocked}
      defaultLocale={defaultLocale}
      onUse={(audio) => {
        languageChoice(voice, audio.id).pick()
        onDone()
      }}
      original={{
        pressed: original.picked,
        blocked: original.blocked,
        onUse: () => {
          if (!original.picked) original.pick()
          onDone()
        },
      }}
      picked={voice.mode === 'dub' ? voice.voice : null}
      title="选择音色"
    />
  )
}

type VoiceOptionProps = {
  voice: ReferenceAudio
  picked: boolean
  blocked: string | undefined
  audition: Audition
  onToggle: () => void
  onUse: () => void
}

/** 选音面板里的一张音色卡：整张点了试听 / 暂停，右边 ✓ 或「选用」。 */
function VoiceOption({ voice, picked, blocked, audition, onToggle, onUse }: VoiceOptionProps) {
  const current = audition.current === voice.id
  const playing = audition.playing === voice.id
  return (
    <li className={cn('wf-card wf-voice-option', picked && 'is-picked', current && 'is-current')}>
      <button
        aria-label={playing ? `暂停试听：${voice.title}` : `试听：${voice.title}`}
        aria-pressed={playing}
        className="wf-voice-option-play ui-focus"
        onClick={onToggle}
        type="button"
      >
        <AudioCover
          id={voice.id}
          size="sm"
          state={playing ? 'playing' : current ? 'paused' : 'idle'}
          title={voice.title}
        >
          {current ? <AuditionBuffering audition={audition} /> : null}
        </AudioCover>
        <AudioCardText
          meta={`${voiceLocaleTag(voice.locale)} · ${audioDurationText(voice.durationMs)}`}
          title={voice.title}
          traits={voiceTraitsText(voice) ?? undefined}
        >
          {current ? (
            <AuditionProgressLine
              audition={audition}
              className="wf-voice-option-progress"
              durationMs={voice.durationMs}
            />
          ) : null}
        </AudioCardText>
      </button>
      {picked ? (
        <span aria-label="正在使用" className="wf-voice-option-used" role="img">
          <Icon decorative name="check" size="sm" />
        </span>
      ) : (
        <BlockedReason reason={blocked}>
          <button
            aria-disabled={blocked === undefined ? undefined : true}
            aria-label={`选用：${voice.title}`}
            className="wf-voice-option-use ui-state ui-focus"
            onClick={() => {
              if (blocked === undefined) onUse()
            }}
            type="button"
          >
            选用
          </button>
        </BlockedReason>
      )}
    </li>
  )
}
