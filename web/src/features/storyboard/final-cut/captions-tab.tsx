import { useEffect, useId, useRef, useState, type ComponentProps, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useAudition } from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from '../components/blocked-reason'
import { captionClock, captionsInOrder, type CaptionsView } from './caption-edit'
import { ComponentTexts } from './component-texts'
import type { CaptionClip } from './composition/film'
import type { LineVoice, LineVoices, VoiceMode } from './composition/voices'
import { NARRATION_TEXT_LIMIT } from './dubbing'
import { LocaleBar, type LocaleControls } from './editor-toolbar'
import { EmptyNote } from './empty-note'
import {
  captionIn,
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  type Language,
  type ShownLocale,
} from './locales'
import { usePausedCommit } from './use-paused-commit'

const ADD_LABEL = '在播放头处加一句'
const RECOGNIZE_LABEL = '识别字幕'
const TRANSLATE_LABEL = '翻译'
const NARRATION_LABEL = '旁白配音'
const INSERT_NARRATION_LABEL = '插入配音与字幕'
const AUDITION_FAILED_TEXT = '音色试听失败，请重试'

/** 改一句字幕在语言 `locale` 里的字（见 `useFilmSession` 的 `setCaptionText`）。 */
export type CaptionTextChange = (id: string, text: string, locale: Language) => void

/** 其它语言下的「翻译」：为什么现在不能点（给了就置灰，点了说明它），是不是在翻译中。 */
type TranslateControl = {
  blocked: string | undefined
  translating: boolean
  onTranslate: () => void
}

/** 参考音频库里的一个音色：名字和试听用的地址。 */
export type VoiceOption = { id: string; name: string; url: string }

/** 音色读不出来的原因和重试。 */
type VoicesProblem = { message: string; onRetry: () => void }

/**
 * 其它语言下的人声设置：`mode` 是现在的设置，`voice` 是记着的配音音色（null 是原声的音色），`voices` 是资料库里
 * 这种语言能用的音色，`voicesProblem` 是它们读不出来的原因；`dubbed` 是这种语言已经有配音片段，`generating` 是正在
 * 给几条素材片生成配音、`narrating` 是正在给几句旁白生成配音（没在生成时都是 0），`generateBlocked` 是现在为什么
 * 不能换音色生成配音，`redoBlocked` 是为什么不能重新生成。`lines` 是各句自己的选择（没有的跟着这种语言的音色），
 * `lineBlocked` 是各句为什么不能单独配音。
 */
export type VoiceControl = {
  mode: VoiceMode
  voice: string | null
  voices: readonly VoiceOption[]
  voicesProblem: VoicesProblem | undefined
  dubbed: boolean
  generating: number
  narrating: number
  generateBlocked: string | undefined
  redoBlocked: string | undefined
  lines: LineVoices
  lineBlocked: ReadonlyMap<string, string>
  onMode: (mode: VoiceMode) => void
  /** 把这种语言的音色换成 `voice`（null 是原声的音色），重配跟着它的句子（已有配音时换掉）。 */
  onGenerate: (voice: string | null) => void
  /** 要配音的句子各用各的音色重新生成。 */
  onRedo: () => void
  /**
   * 改一句的选择（null 是跟着这种语言的音色）：选音色时只重配这一句（实际用的音色没变、已有配音时只改选择），
   * 不配音时删掉它的配音。
   */
  onLine: (caption: string, line: LineVoice | null) => void
}

/**
 * 原文下的「旁白配音」：`open` 是展开着没有，`voices` 是资料库里的音色（还在读时是 undefined），`voicesProblem` 是
 * 它们读不出来的原因；`generating` 是有配音正在生成，`blocked` 是文案、音色以外为什么现在不能插入。
 */
export type NarrationControl = {
  open: boolean
  onOpen: (open: boolean) => void
  voices: readonly VoiceOption[] | undefined
  voicesProblem: VoicesProblem | undefined
  generating: boolean
  blocked: string | undefined
  /** 用资料库里的音色 `voice` 把 `text` 合成旁白，合成好后连同一句字幕插进时间线。 */
  onInsert: (text: string, voice: string) => void
}

type CaptionsTabProps = {
  /** 这个页签是不是正显示着；被藏起来时停止试听音色。 */
  active: boolean
  /** 提示一句话（试听失败时）。 */
  onNotice: (message: string) => void
  /** 其它语言下的「翻译」；原文时是 undefined，不显示。 */
  translate: TranslateControl | undefined
  /** 其它语言下的人声设置；原文时是 undefined，不显示。 */
  voice: VoiceControl | undefined
  /** 原文下的「旁白配音」；其它语言时是 undefined，不显示。 */
  narration: NarrationControl | undefined
  captions: readonly CaptionClip[]
  /** 「组件文字」那一段（显示着的语言、选中的片段和这里共用）。 */
  texts: Omit<ComponentProps<typeof ComponentTexts>, 'locale' | 'selected'>
  /** 显示着的语言：其它语言时文字框里是这种语言的字，旁边写着原文。 */
  locale: ShownLocale
  /** 最上面的语言切换和添加，和工具条上的是同一份。 */
  locales: LocaleControls
  /** 编辑器里选中的片段的编号。 */
  selected: ReadonlySet<string>
  /** 选中的片段在这里对应什么（见 `captionsFocus`）：列表里标出哪几句，选中变了时切到哪一段。 */
  focus: { lines: ReadonlySet<string>; view: CaptionsView | undefined }
  /** 为什么现在不能在播放头处加一句；给了就把按钮置灰，点了说明它。 */
  addBlocked: string | undefined
  /** 正在识别几个视频片段的字幕；没在识别时是 0。 */
  recognizing: number
  /** 为什么现在不能识别字幕；给了就把「识别字幕」置灰，点了说明它。 */
  recognizeBlocked: string | undefined
  onRecognize: () => void
  /** 字幕写法不对时的原因，显示在最上面。 */
  problem: string | undefined
  /** 在播放头处加一句，答复新字幕的编号；没加上时是 undefined。 */
  onAdd: () => Promise<string | undefined>
  onText: CaptionTextChange
  onRemove: (id: string) => void
  /** 点了一句的时间：选中它、播放头跳到它的开始。 */
  onPick: (caption: CaptionClip) => void
}

/**
 * 「字幕」页签。顶行左边是语言小块（见 `LocaleBar`），右边在「字幕」和「组件文字」（见 `ComponentTexts`）两段之间
 * 切换，各写着有几个。下一行是动作：其它语言下的「翻译」（两段里还没翻的一起翻），「字幕」段里还有识别字幕、原文下的
 * 「旁白配音」（展开见 `NarrationPanel`）和最右边在播放头处加一句的「+」。「字幕」段下面是按开始时间排的字幕卡片，
 * 每句能直接改字、删掉，点时间选中它、跳到它的开始。编辑器里选中的字幕、选中的配音片段配的那句标成当前这一句；
 * 刚加的那一句焦点进它的文字框。识别中写着在识别几个片段。其它语言下改的是这种语言的字，「字幕」段上面多一块人声
 * 设置（见 `VoiceCard`）。
 *
 * 两段跟着选中走：选中变了的那一下，选中字幕或配音片段时切到「字幕」，选中有文字的贴片、场景时切到「组件文字」；
 * 之后用户自己切了另一段就听用户的，等下一次选中变了再切。
 */
export function CaptionsTab({
  active,
  onNotice,
  translate,
  voice,
  narration,
  captions,
  texts,
  locale,
  locales,
  selected,
  focus,
  addBlocked,
  recognizing,
  recognizeBlocked,
  onRecognize,
  problem,
  onAdd,
  onText,
  onRemove,
  onPick,
}: CaptionsTabProps) {
  const [focusing, setFocusing] = useState<string | null>(null)
  const [view, setView] = useState<CaptionsView>(focus.view ?? 'captions')
  const selectionKey = [...selected].sort().join(' ')
  const [seenSelection, setSeenSelection] = useState(selectionKey)
  if (selectionKey !== seenSelection) {
    setSeenSelection(selectionKey)
    if (focus.view !== undefined) setView(focus.view)
  }
  const add = async () => {
    if (addBlocked !== undefined) return
    const id = await onAdd()
    if (id !== undefined) setFocusing(id)
  }
  const views = [
    { value: 'captions', label: '字幕', count: captions.length },
    { value: 'texts', label: '组件文字', count: texts.hosts.length },
  ] as const
  const onCaptions = view === 'captions'
  return (
    <div className="wf-captions">
      <div className="wf-tab-head wf-captions-head">
        <div className="wf-captions-top">
          <LocaleBar {...locales} inPanel />
          <div aria-label="字幕或组件文字" className="wf-seg wf-captions-views" role="group">
            {views.map((each) => (
              <button
                aria-pressed={view === each.value}
                className="wf-seg-item ui-state ui-focus"
                key={each.value}
                onClick={() => setView(each.value)}
                type="button"
              >
                {each.label} <span className="wf-captions-count">{each.count}</span>
              </button>
            ))}
          </div>
        </div>
        {translate === undefined && !onCaptions ? null : (
          <div className="wf-captions-actions">
            {translate === undefined ? null : (
              <BlockedReason reason={translate.blocked}>
                <button
                  aria-disabled={translate.blocked === undefined ? undefined : true}
                  className="wf-chip-btn is-soft ui-state ui-focus"
                  onClick={() => {
                    if (translate.blocked === undefined) translate.onTranslate()
                  }}
                  type="button"
                >
                  <Icon decorative name="final-cut-translate" size="sm" />
                  {translate.translating ? '翻译中…' : TRANSLATE_LABEL}
                </button>
              </BlockedReason>
            )}
            {onCaptions ? (
              <>
                <BlockedReason reason={recognizeBlocked}>
                  <button
                    aria-disabled={recognizeBlocked === undefined ? undefined : true}
                    className="wf-chip-btn ui-state ui-focus"
                    onClick={() => {
                      if (recognizeBlocked === undefined) onRecognize()
                    }}
                    type="button"
                  >
                    <Icon decorative name="final-cut-voice" size="sm" />
                    {recognizing > 0 ? '识别中…' : RECOGNIZE_LABEL}
                  </button>
                </BlockedReason>
                {narration === undefined ? null : (
                  <button
                    aria-expanded={narration.open}
                    className={cn('wf-chip-btn ui-state ui-focus', narration.open && 'is-active')}
                    onClick={() => narration.onOpen(!narration.open)}
                    type="button"
                  >
                    <Icon decorative name="final-cut-narration" size="sm" />
                    {narration.open ? '收起' : NARRATION_LABEL}
                  </button>
                )}
                <AddLineButton blocked={addBlocked} onAdd={() => void add()} />
              </>
            ) : null}
          </div>
        )}
      </div>
      {problem === undefined ? null : (
        <InlineAlert className="wf-captions-alert" message={problem} />
      )}
      {onCaptions && voice !== undefined ? (
        <VoiceCard active={active} onNotice={onNotice} voice={voice} />
      ) : null}
      {onCaptions ? (
        <CaptionsView
          active={active}
          captions={captions}
          focusing={focusing}
          lines={focus.lines}
          locale={locale}
          narration={narration}
          onFocused={() => setFocusing(null)}
          onNotice={onNotice}
          onPick={onPick}
          onRemove={onRemove}
          onText={onText}
          recognizing={recognizing}
          voice={voice}
        />
      ) : (
        <ComponentTexts {...texts} locale={locale} selected={selected} />
      )}
    </div>
  )
}

/**
 * 字幕操作一行最右边的「+」：在播放头处加一句。悬停提示写这个名字；加不了时置灰，提示和点击都说明原因
 * （和工具条上加不了语言的「+」一样，见 `editor-toolbar.tsx` 的 `BlockedAddLocale`）。
 */
function AddLineButton({ blocked, onAdd }: { blocked: string | undefined; onAdd: () => void }) {
  const [hint, setHint] = useState(false)
  return (
    <TooltipRoot onOpenChange={setHint} open={hint}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          if (blocked === undefined) return
          event.preventDefault()
          setHint(true)
        }}
      >
        <button
          aria-disabled={blocked === undefined ? undefined : true}
          aria-label={ADD_LABEL}
          className="wf-captions-add ui-state ui-focus"
          onClick={() => {
            if (blocked === undefined) onAdd()
          }}
          type="button"
        >
          <Icon decorative name="final-cut-add" size="md" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {blocked ?? ADD_LABEL}
      </TooltipContent>
    </TooltipRoot>
  )
}

const GENERATING_TEXT = '正在生成配音，请等待生成完成'

const ORIGINAL_VOICE = '原声'

/** 有配音正在生成（素材片的或旁白的）时为什么不能点。 */
const busyOf = ({ generating, narrating }: Pick<VoiceControl, 'generating' | 'narrating'>) =>
  generating + narrating > 0 ? GENERATING_TEXT : undefined

/**
 * 其它语言下的人声设置，一张卡片：标题行是「人声」、「保留原声」，有配音时右边多一个「重新生成」（要配音的句子各用
 * 各的音色）；下面是 AI 配音的音色小块：「原声」（从素材片的原声里取）在前，后面是资料库里的音色（能试听）。保留原声
 * 和选中的音色二选一，当前的高亮。点一个音色：这种语言已有用它配好的配音时只切过去，不然把它当这种语言的音色、重配
 * 跟着它的句子（生成完自动用上，已有配音时换掉）。生成中写着在给几条素材片、几句旁白配音。
 */
function VoiceCard({
  voice,
  active,
  onNotice,
}: {
  voice: VoiceControl
  active: boolean
  onNotice: (message: string) => void
}) {
  const { mode, voice: current, voices, voicesProblem, dubbed, generating, narrating } = voice
  const { generateBlocked, onMode, onGenerate, onRedo } = voice
  const { playing, toggle } = useAudition({
    active,
    onError: () => onNotice(AUDITION_FAILED_TEXT),
  })
  const busy = busyOf(voice)
  const redoBlocked = busy ?? voice.redoBlocked
  const switchesOnly = (id: string | null) => dubbed && id === current
  const chipOf = (id: string | null, name: string) => {
    const blocked = switchesOnly(id) ? busy : (busy ?? generateBlocked)
    return {
      blocked,
      name,
      onPick: () => {
        if (blocked !== undefined) return
        if (switchesOnly(id)) onMode('dub')
        else onGenerate(id)
      },
      picked: mode === 'dub' && current === id,
    }
  }
  return (
    <div aria-label="人声设置" className="wf-card wf-voice-card" role="group">
      <div className="wf-voice-head">
        <span className="wf-voice-title">
          <Icon decorative name="final-cut-voice" size="sm" />
          人声
        </span>
        <button
          aria-pressed={mode === 'original'}
          className="wf-chip-btn ui-state ui-focus"
          onClick={() => onMode('original')}
          type="button"
        >
          保留原声
        </button>
        {dubbed ? (
          <BlockedReason reason={redoBlocked}>
            <button
              aria-disabled={redoBlocked === undefined ? undefined : true}
              className="wf-chip-btn ui-state ui-focus"
              onClick={() => {
                if (redoBlocked === undefined) onRedo()
              }}
              type="button"
            >
              重新生成
            </button>
          </BlockedReason>
        ) : null}
      </div>
      <div aria-label="AI 配音音色" className="wf-voice-list" role="group">
        <VoiceChip {...chipOf(null, ORIGINAL_VOICE)} />
        {voices.map((each) => (
          <VoiceChip
            key={each.id}
            {...chipOf(each.id, each.name)}
            audition={{
              playing: playing === each.id,
              onToggle: () => toggle(each.id, each.url),
            }}
          />
        ))}
      </div>
      {voicesProblem === undefined ? null : (
        <InlineAlert
          action={{ label: '重试', onClick: voicesProblem.onRetry }}
          message={voicesProblem.message}
        />
      )}
      {generating + narrating > 0 ? (
        <p className="wf-voice-note" role="status">
          {`正在为 ${[
            generating > 0 ? `${generating} 条素材片` : '',
            narrating > 0 ? `${narrating} 句旁白` : '',
          ]
            .filter((part) => part !== '')
            .join('、')}生成配音，可继续编辑`}
        </p>
      ) : null}
    </div>
  )
}

type VoiceChipProps = {
  name: string
  picked: boolean
  /** 为什么现在不能点；给了就置灰，点了说明它。 */
  blocked: string | undefined
  onPick: () => void
  /** 资料库里的音色能试听；「原声」没有。 */
  audition?: { playing: boolean; onToggle: () => void }
}

/** 一个音色小块：前面是试听钮（有的话），后面是音色的名字，点名字选它。 */
function VoiceChip({ name, picked, blocked, onPick, audition }: VoiceChipProps) {
  return (
    <span className={cn('wf-voice-chip', picked && 'is-picked')}>
      {audition === undefined ? null : (
        <IconButton
          aria-pressed={audition.playing}
          className="wf-voice-play"
          label={audition.playing ? `暂停试听：${name}` : `试听：${name}`}
          name={audition.playing ? 'final-cut-pause' : 'final-cut-play'}
          onClick={audition.onToggle}
          size="xs"
        />
      )}
      <BlockedReason reason={blocked}>
        <button
          aria-disabled={blocked === undefined ? undefined : true}
          aria-pressed={picked}
          className="wf-voice-pick ui-state ui-focus"
          onClick={onPick}
          title={name}
          type="button"
        >
          {name}
        </button>
      </BlockedReason>
    </span>
  )
}

const FOLLOW = 'follow'
const ORIGINAL = 'original'
const UNVOICED = 'unvoiced'
const UNVOICED_NAME = '不配音'
// 记着的音色已不在资料库里（移除了，或还没读到）
const LIBRARY_VOICE_NAME = '资料库音色'

/** 菜单里一项的值 → 这句的选择（null 是跟着这种语言的音色）。 */
const lineVoiceOfValue = (value: string): LineVoice | null =>
  value === FOLLOW
    ? null
    : value === UNVOICED
      ? { dub: false }
      : { voice: value === ORIGINAL ? null : value.slice('voice:'.length) }

/** 这句的选择 → 菜单里打勾的那一项。 */
const valueOfLineVoice = (line: LineVoice | undefined): string =>
  line === undefined
    ? FOLLOW
    : 'dub' in line
      ? UNVOICED
      : line.voice === null
        ? ORIGINAL
        : `voice:${line.voice}`

/**
 * 一句字幕在其它语言下的配音小块。保留原声时只是一个「原声」标签；AI 配音时写着这句现在的音色（跟着这种语言的
 * 音色时是它，原声的音色写「原声」），不配音写「不配音」，自己选过的和跟着的样子不一样。点开菜单选：「跟随整体
 * 音色」、「原声」、资料库里的音色、「不配音」，现在的选择打勾。这句配不了音、有配音在生成时置灰，点了说明原因。
 */
function LineVoiceChip({ caption, voice }: { caption: string; voice: VoiceControl }) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  if (voice.mode === 'original') return <span className="wf-line-voice">{ORIGINAL_VOICE}</span>
  const own = Object.hasOwn(voice.lines, caption) ? voice.lines[caption] : undefined
  const chosen = own ?? { voice: voice.voice }
  const unvoiced = 'dub' in chosen
  const name =
    'dub' in chosen
      ? UNVOICED_NAME
      : chosen.voice === null
        ? ORIGINAL_VOICE
        : (voice.voices.find((each) => each.id === chosen.voice)?.name ?? LIBRARY_VOICE_NAME)
  const label = `本句配音：${name}${own === undefined ? '，跟随整体音色' : ''}`
  const blocked = busyOf(voice) ?? voice.lineBlocked.get(caption)
  const chip = (
    <button
      aria-disabled={blocked === undefined ? undefined : true}
      aria-label={label}
      className={cn(
        'wf-line-voice is-voiced ui-state ui-focus',
        own !== undefined && 'is-own',
        unvoiced && 'is-unvoiced',
      )}
      type="button"
    >
      <span className="wf-line-voice-name">{name}</span>
      <Icon decorative name="final-cut-expand" size="xs" />
    </button>
  )
  if (blocked !== undefined) return <BlockedReason reason={blocked}>{chip}</BlockedReason>
  const picked = valueOfLineVoice(own)
  return (
    <MenuRoot
      onOpenChange={(next) => {
        setOpen(next)
        setHint(false)
      }}
      open={open}
    >
      {/* 和工具条的下拉一样：菜单开着时不出提示 */}
      <TooltipRoot onOpenChange={setHint} open={hint && !open}>
        <MenuTrigger asChild>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" side="top">
          切换本句配音音色或不配音
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="end" className="wf-menu">
        <MenuRadioGroup
          onValueChange={(value) => {
            if (value !== picked) voice.onLine(caption, lineVoiceOfValue(value))
          }}
          value={picked}
        >
          <MenuRadioItem value={FOLLOW}>跟随整体音色</MenuRadioItem>
          <MenuRadioItem value={ORIGINAL}>{ORIGINAL_VOICE}</MenuRadioItem>
          {voice.voices.map((each) => (
            <MenuRadioItem key={each.id} value={`voice:${each.id}`}>
              {each.name}
            </MenuRadioItem>
          ))}
          <MenuRadioItem value={UNVOICED}>{UNVOICED_NAME}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}

/** 「字幕」那一段：原文下展开的「旁白配音」（见 `NarrationPanel`）、识别中的说明和字幕列表。 */
function CaptionsView({
  active,
  onNotice,
  captions,
  locale,
  lines,
  recognizing,
  focusing,
  onFocused,
  onText,
  onRemove,
  onPick,
  voice,
  narration,
}: Pick<
  CaptionsTabProps,
  | 'active'
  | 'onNotice'
  | 'captions'
  | 'locale'
  | 'recognizing'
  | 'onText'
  | 'onRemove'
  | 'onPick'
  | 'voice'
  | 'narration'
> & {
  /** 标成当前的那几句。 */
  lines: ReadonlySet<string>
  /** 焦点要进的那一句（刚加的）。 */
  focusing: string | null
  onFocused: () => void
}) {
  return (
    <>
      {narration?.open === true ? (
        <NarrationPanel active={active} narration={narration} onNotice={onNotice} />
      ) : null}
      {recognizing > 0 ? (
        <p className="wf-captions-note" role="status">
          正在识别 {recognizing} 个视频片段的字幕，可继续编辑
        </p>
      ) : null}
      {captions.length === 0 ? (
        recognizing > 0 ? null : (
          <EmptyNote icon="final-cut-captions">
            暂无字幕，请点击「{RECOGNIZE_LABEL}」或「{ADD_LABEL}」
          </EmptyNote>
        )
      ) : (
        <ol aria-label="字幕" className="wf-tab-list wf-caption-list">
          {captionsInOrder(captions).map((caption) => (
            <CaptionRow
              caption={caption}
              current={lines.has(caption.id)}
              focus={caption.id === focusing}
              key={caption.id}
              locale={locale}
              onFocused={onFocused}
              onRemove={() => onRemove(caption.id)}
              onSeek={() => onPick(caption)}
              onText={onText}
              voice={voice}
            />
          ))}
        </ol>
      )}
    </>
  )
}

const NO_VOICES_TEXT = '资料库里暂无音色，请先在资料库的「音频库」里加入音色'
const NO_NARRATION_VOICE_TEXT =
  '没有可用的音色，无法插入旁白配音；请先在资料库的「音频库」里加入音色'
const NO_NARRATION_TEXT = '旁白文案为空，无法插入旁白配音；请先输入文案'

/**
 * 「旁白配音」展开的一块：两行的文案框，资料库里的音色小块（能试听，点名字选它，默认选第一个），最下面一行左边是选着
 * 的音色，右边是「插入配音与字幕」（有配音在生成时写「合成中…」）。文案空着、超字数、没有音色、或者 `blocked` 时
 * 按钮置灰，点了说明原因。
 */
function NarrationPanel({
  narration,
  active,
  onNotice,
}: {
  narration: NarrationControl
  active: boolean
  onNotice: (message: string) => void
}) {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const { playing, toggle } = useAudition({ active, onError: () => onNotice(AUDITION_FAILED_TEXT) })
  const voices = narration.voices ?? []
  const voice = voices.find((each) => each.id === picked) ?? voices[0]
  const draft = text.trim()
  const blocked =
    narration.blocked ??
    (voice === undefined
      ? NO_NARRATION_VOICE_TEXT
      : draft === ''
        ? NO_NARRATION_TEXT
        : draft.length > NARRATION_TEXT_LIMIT
          ? `旁白文案超过 ${NARRATION_TEXT_LIMIT} 字，无法插入旁白配音；请删减`
          : undefined)
  return (
    <div aria-label={NARRATION_LABEL} className="wf-card wf-voice-card" role="group">
      <Textarea
        aria-label="旁白文案"
        className="wf-field wf-narration-text"
        onChange={(event) => setText(event.target.value)}
        placeholder="输入旁白文案…"
        rows={2}
        value={text}
      />
      {narration.voices === undefined || voices.length > 0 ? (
        <div aria-label="旁白音色" className="wf-voice-list" role="group">
          {voices.map((each) => (
            <VoiceChip
              audition={{
                playing: playing === each.id,
                onToggle: () => toggle(each.id, each.url),
              }}
              blocked={undefined}
              key={each.id}
              name={each.name}
              onPick={() => setPicked(each.id)}
              picked={each.id === voice?.id}
            />
          ))}
        </div>
      ) : (
        <p className="wf-voice-note" role="status">
          {NO_VOICES_TEXT}
        </p>
      )}
      {narration.voicesProblem === undefined ? null : (
        <InlineAlert
          action={{ label: '重试', onClick: narration.voicesProblem.onRetry }}
          message={narration.voicesProblem.message}
        />
      )}
      <div className="wf-narration-foot">
        <span className="wf-narration-voice">{voice?.name}</span>
        <BlockedReason reason={blocked}>
          <button
            aria-disabled={blocked === undefined ? undefined : true}
            className="wf-chip-btn is-soft ui-state ui-focus"
            onClick={() => {
              if (blocked === undefined && voice !== undefined) narration.onInsert(draft, voice.id)
            }}
            type="button"
          >
            {narration.generating ? '合成中…' : INSERT_NARRATION_LABEL}
          </button>
        </BlockedReason>
      </div>
    </div>
  )
}

type CaptionRowProps = {
  caption: CaptionClip
  locale: ShownLocale
  current: boolean
  /** 焦点要进这一句的文字框（刚加的那一句）。 */
  focus: boolean
  onFocused: () => void
  onText: CaptionTextChange
  onRemove: () => void
  onSeek: () => void
  /** 其它语言下的人声设置：右上多一个这句的配音小块（见 `LineVoiceChip`）；原文时是 undefined。 */
  voice: VoiceControl | undefined
}

/** 一句字幕：起止时间、这句的配音（其它语言下）、删除钮和文字框。 */
function CaptionRow({
  caption,
  locale,
  current,
  focus,
  onFocused,
  onText,
  onRemove,
  onSeek,
  voice,
}: CaptionRowProps) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!focus) return
    fieldRef.current?.focus()
    fieldRef.current?.select()
    onFocused()
  }, [focus, onFocused])

  const range = `${captionClock(caption.start)} – ${captionClock(caption.start + caption.duration)}`
  return (
    <li
      aria-current={current ? 'true' : undefined}
      className={cn('wf-caption wf-card', current && 'is-current')}
    >
      <div className="wf-caption-head">
        <button className="wf-caption-time ui-focus" onClick={onSeek} type="button">
          <Icon decorative name="final-cut-play" size="xs" />
          {range}
        </button>
        {voice === undefined ? null : <LineVoiceChip caption={caption.id} voice={voice} />}
        <IconButton
          className="wf-caption-remove"
          label={`删除 ${range} 的字幕`}
          name="final-cut-delete"
          onClick={onRemove}
          size="xs"
        />
      </div>
      <CaptionTextField
        aria-label={`字幕文字 ${range}`}
        caption={caption}
        className="wf-caption-text"
        key={locale.code}
        locale={locale}
        onText={onText}
        ref={fieldRef}
      />
    </li>
  )
}

type CaptionTextFieldProps = {
  caption: CaptionClip
  /** 显示着的语言；换了语言时调用方要换一个文字框（按语言给 `key`），没写的字留在原来的语言里。 */
  locale: ShownLocale
  onText: CaptionTextChange
  className: string
  ref?: Ref<HTMLTextAreaElement>
  id?: string
  'aria-label'?: string
}

/**
 * 一句字幕的文字框（「字幕」页签和「属性」共用）：回车是换行，停下 300 毫秒再写进去（见 `usePausedCommit`）。
 * 其它语言下框里是这种语言的字，还没翻时是空的、占位字提示输入这种语言，下面写着原文。
 */
export function CaptionTextField({ caption, locale, onText, ...field }: CaptionTextFieldProps) {
  const { draft, fieldProps } = usePausedCommit((text) => onText(caption.id, text, locale.code))
  const sourceId = useId()
  const shown = captionIn(locale, caption)
  const foreign = locale.values !== null

  return (
    <>
      <Textarea
        {...field}
        {...fieldProps}
        aria-describedby={foreign ? sourceId : undefined}
        placeholder={
          locale.code === SOURCE_LOCALE ? undefined : phraseWith('输入', locale.code, '字幕…')
        }
        rows={2}
        value={draft ?? shown.text}
      />
      {foreign ? (
        <p className="wf-caption-source" id={sourceId}>
          <span className="wf-caption-source-tag">{SOURCE_NAME}</span> {caption.text}
        </p>
      ) : null}
    </>
  )
}
