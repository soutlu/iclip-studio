import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { Audition } from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from '../components/blocked-reason'
import { TabAuditionBar } from './audio-card'
import { captionClock, captionsInOrder, type CaptionsView } from './caption-edit'
import type { ScriptNote } from './caption-script'
import { ComponentTexts } from './component-texts'
import { ownsStyle } from './composition/captions'
import type { CaptionClip } from './composition/film'
import { NARRATION_TEXT_LIMIT } from './dubbing'
import { LocaleBar, type LocaleControls } from './editor-toolbar'
import { EmptyNote } from './empty-note'
import { LineVoiceChip } from './line-voice'
import {
  captionIn,
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  type Language,
  type ShownLocale,
} from './locales'
import { usePausedCommit } from './use-paused-commit'
import { useTabAudition } from './use-tab-audition'
import { CurrentVoice, VoiceCard } from './voice-card'
import {
  commonVoices,
  ownLineVoice,
  voiceNameOf,
  type VoiceControl,
  type VoiceLibrary,
} from './voice-choices'
import { TargetVoicePicker, type VoicePick } from './voice-picker'

const ADD_LABEL = '在播放头处添加字幕'
const RECOGNIZE_LABEL = '识别字幕'
const TRANSLATE_LABEL = '翻译'
const NARRATION_LABEL = '旁白配音'
const INSERT_NARRATION_LABEL = '插入配音与字幕'
const AUDITION_FAILED_TEXT = '音色试听失败，请重试'
const OWN_STYLE_LABEL = '已单独设置样式'

/** 修改指定字幕在目标语言 `locale` 下的文本（见 `useFilmSession` 的 `setCaptionText`）。 */
export type CaptionTextChange = (id: string, text: string, locale: Language) => void

/** 译文语言下的「翻译」控制：包含禁用原因与翻译进行中状态。 */
type TranslateControl = {
  blocked: string | undefined
  translating: boolean
  onTranslate: () => void
}

/**
 * 原文语言下的「旁白配音」面板控制：`open` 为展开状态，`generating` 标识正在合成旁白，`blocked` 为除文案与音色外的
 * 外部阻断原因。
 */
type NarrationControl = {
  open: boolean
  onOpen: (open: boolean) => void
  generating: boolean
  blocked: string | undefined
  /** 使用资料库音色 `voice` 将 `text` 合成为旁白，完成后连同对应字幕一并插入时间线。 */
  onInsert: (text: string, voice: string) => void
}

type CaptionsTabProps = {
  /** 当前页签是否可见；隐藏时自动停止音色试听。 */
  active: boolean
  /** 操作提示回调（如试听失败时提示）。 */
  onNotice: (message: string) => void
  /** 译文语言下的「翻译」控制；原文语言时为 `undefined`（不展示）。 */
  translate: TranslateControl | undefined
  /** 译文语言下的人声配置；原文语言时为 `undefined`（不展示）。 */
  voice: VoiceControl | undefined
  /** 原文语言下的「旁白配音」控制；译文语言时为 `undefined`（不展示）。 */
  narration: NarrationControl | undefined
  /** 资料库音色：人声卡、旁白和单句菜单从这里找名字、属性和常用音色。 */
  library: VoiceLibrary
  captions: readonly CaptionClip[]
  /** 「画面文字」视图配置（与当前展示语言及选中片段共享状态）。 */
  texts: Omit<ComponentProps<typeof ComponentTexts>, 'locale' | 'selected'>
  /** 当前展示语言：译文语言下输入框编辑译文，并在下方附带原文对照。 */
  locale: ShownLocale
  /** 顶部语言切换与添加控制，与底部工具条共享同一份状态。 */
  locales: LocaleControls
  /** 编辑器当前选中的片段 ID 集合。 */
  selected: ReadonlySet<string>
  /** 当前选中片段在字幕页签内的聚焦映射（见 `captionsFocus`）：决定高亮句及自动切换视图。 */
  focus: { lines: ReadonlySet<string>; view: CaptionsView | undefined }
  /** 无法在播放头处新增字幕时的禁用原因；非空时置灰按钮并在点击时提示。 */
  addBlocked: string | undefined
  /** 正在执行语音识别的视频片段数量；空闲时为 0。 */
  recognizing: number
  /** 无法触发字幕识别时的禁用原因；非空时置灰「识别字幕」并在点击时提示。 */
  recognizeBlocked: string | undefined
  /** 识别结果提示，有值时在「识别字幕」旁展示；收起时调用 `onRecognizeNoteClose`。 */
  recognizeNote: string | undefined
  onRecognizeNoteClose: () => void
  onRecognize: () => void
  /** 与原始台词存在差异的字幕映射（字幕 ID → 台词对照），在该句输入框下方展示（见 `useCaptionScripts`）。 */
  scripts: ReadonlyMap<string, ScriptNote>
  /** 字幕文件结构异常提示，置顶展示。 */
  problem: string | undefined
  /** 在播放头处新增一句字幕并返回新字幕 ID；未成功添加时返回 `undefined`。 */
  onAdd: () => Promise<string | undefined>
  onText: CaptionTextChange
  onRemove: (id: string) => void
  /** 点击字幕时间按钮：选中该字幕并将播放头跳转至其起始时刻。 */
  onPick: (caption: CaptionClip) => void
}

/**
 * 「字幕」页签：顶栏左侧为语言切换（见 `LocaleBar`），右侧在「字幕」与「画面文字」（见 `ComponentTexts`）间切换并附数量统计；
 * 次行为操作栏：包含译文语言的「翻译」（统一翻译两视图未译项）、「字幕」视图的「识别字幕」、原文语言的「旁白配音」（展开见 `NarrationPanel`）
 * 及右侧在播放头处新增字幕的「+」。列表按起始时间排序，支持直接编辑、删除及点击时间定位；
 * 选中字幕或对应配音片段时高亮当前句，新增字幕自动聚焦输入框；译文语言下顶部额外展示人声配置卡（见 `VoiceCard`）。
 * 人声卡、单句菜单和旁白的「更换」把页签头下面的内容换成选音面板（见 `TargetVoicePicker`），选用或返回后回到这里；
 * 整个页签共用一个试听，有当前试听时底部贴一条试听条。
 *
 * 视图随选区变化自动跟随：选中字幕或配音时切至「字幕」，选中含文字的元素/模板片段时切至「画面文字」；
 * 用户手动切换视图后保持选择，直至下次选区发生变化。
 */
export function CaptionsTab({
  active,
  onNotice,
  translate,
  voice,
  narration,
  library,
  captions,
  texts,
  locale,
  locales,
  selected,
  focus,
  addBlocked,
  recognizing,
  recognizeBlocked,
  recognizeNote,
  onRecognizeNoteClose,
  onRecognize,
  scripts,
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
    { value: 'texts', label: '画面文字', count: texts.hosts.length },
  ] as const
  const onCaptions = view === 'captions'

  const {
    audition,
    toggle,
    shown: auditioning,
  } = useTabAudition({ active, onError: () => onNotice(AUDITION_FAILED_TEXT) })
  const onToggle = (audio: ReferenceAudio) =>
    toggle({
      id: audio.id,
      url: audio.url,
      title: audio.title,
      peaks: audio.peaks,
      traits: audio,
      durationMs: audio.durationMs,
    })
  // 旁白要用的音色：没换过时是资料库的第一个音色
  const [narrationChoice, setNarrationChoice] = useState<string | null>(null)
  const narrationVoice = narrationChoice ?? library.voices?.[0]?.id ?? null
  // 选音面板给谁选：换了语言、收起旁白、切到「画面文字」时关掉
  const [picking, setPicking] = useState<{ pick: VoicePick; locale: Language } | null>(null)
  const pick =
    onCaptions &&
    picking !== null &&
    picking.locale === locale.code &&
    (picking.pick.target === 'narration' ? narration?.open === true : voice !== undefined)
      ? picking.pick
      : null
  if (picking !== null && pick === null) setPicking(null)
  // 关掉面板后焦点回到打开它的按钮上（它跟着首页藏起来过）
  const openerRef = useRef<HTMLElement | null>(null)
  const openPicker = (next: VoicePick) => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPicking({ pick: next, locale: locale.code })
  }
  useEffect(() => {
    if (pick !== null || openerRef.current === null) return
    if (openerRef.current.isConnected) openerRef.current.focus()
    openerRef.current = null
  }, [pick])
  const common =
    voice === undefined || locale.code === SOURCE_LOCALE
      ? []
      : commonVoices(
          [
            voice.voice,
            ...captionsInOrder(captions).map((caption) => {
              const own = ownLineVoice(voice, caption.id)
              return own !== undefined && 'voice' in own ? own.voice : null
            }),
          ],
          library.voices ?? [],
          locale.code,
        )

  return (
    <div className="wf-captions">
      <div className="wf-tab-head wf-captions-head">
        <div className="wf-captions-top">
          <LocaleBar {...locales} inPanel />
          <div aria-label="字幕或画面文字" className="wf-seg wf-captions-views" role="group">
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
                <RecognizeButton
                  blocked={recognizeBlocked}
                  note={recognizeNote}
                  onNoteClose={onRecognizeNoteClose}
                  onRecognize={onRecognize}
                  recognizing={recognizing}
                />
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
      {pick === null ? null : (
        <TargetVoicePicker
          audition={audition}
          key={pick.target === 'line' ? `line:${pick.caption}` : pick.target}
          locale={locale.code}
          narrationVoice={narrationVoice}
          onDone={() => setPicking(null)}
          onNarrationVoice={setNarrationChoice}
          onToggle={onToggle}
          pick={pick}
          voice={voice}
        />
      )}
      {/* 选音面板开着时首页只藏起来：旁白文案、没存下的字幕草稿和滚动位置都留着 */}
      <div className="wf-captions-home" hidden={pick !== null}>
        {problem === undefined ? null : (
          <InlineAlert className="wf-captions-alert" message={problem} />
        )}
        {onCaptions && voice !== undefined ? (
          <VoiceCard
            audition={audition}
            common={common}
            library={library}
            onChange={() => openPicker({ target: 'language' })}
            onToggle={onToggle}
            voice={voice}
          />
        ) : null}
        {onCaptions ? (
          <CaptionsView
            captions={captions}
            focusing={focusing}
            lineChip={(caption) =>
              voice === undefined ? null : (
                <LineVoiceChip
                  caption={caption}
                  common={common}
                  library={library.voices}
                  onMore={() => openPicker({ target: 'line', caption })}
                  voice={voice}
                />
              )
            }
            lines={focus.lines}
            locale={locale}
            narrationPanel={
              narration?.open === true ? (
                <NarrationPanel
                  audition={audition}
                  library={library}
                  narration={narration}
                  onChange={() => openPicker({ target: 'narration' })}
                  onToggle={onToggle}
                  voice={narrationVoice}
                />
              ) : null
            }
            onFocused={() => setFocusing(null)}
            onPick={onPick}
            onRemove={onRemove}
            onText={onText}
            recognizing={recognizing}
            scripts={scripts}
          />
        ) : (
          <ComponentTexts {...texts} locale={locale} selected={selected} />
        )}
      </div>
      {auditioning === null ? null : <TabAuditionBar audition={audition} item={auditioning} />}
    </div>
  )
}

/**
 * 字幕操作栏最右侧的「+」按钮：在播放头处新增一句字幕。悬停展示功能名；不可用时置灰并在悬停及点击时说明原因
 * （交互行为与工具条禁用按钮一致，见 `editor-toolbar.tsx` 的 `Tool`）。
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

/**
 * 「识别字幕」按钮。不可用时置灰，悬停或点击说明原因（同 `BlockedReason`）；`note` 有值时在按钮旁展示识别结果提示，
 * 鼠标移开、按 Esc 或再点按钮时收起并调用 `onNoteClose`。
 */
function RecognizeButton({
  blocked,
  note,
  onNoteClose,
  recognizing,
  onRecognize,
}: {
  blocked: string | undefined
  note: string | undefined
  onNoteClose: () => void
  recognizing: number
  onRecognize: () => void
}) {
  const [hint, setHint] = useState(false)
  const shown = note ?? (hint ? blocked : undefined)
  return (
    <TooltipRoot
      onOpenChange={(open) => {
        setHint(open && blocked !== undefined)
        if (!open && note !== undefined) onNoteClose()
      }}
      open={shown !== undefined}
    >
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
          className="wf-chip-btn ui-state ui-focus"
          onClick={() => {
            if (blocked === undefined) onRecognize()
          }}
          type="button"
        >
          <Icon decorative name="final-cut-voice" size="sm" />
          {recognizing > 0 ? '识别中…' : RECOGNIZE_LABEL}
        </button>
      </TooltipTrigger>
      {shown === undefined ? null : <TooltipContent side="top">{shown}</TooltipContent>}
    </TooltipRoot>
  )
}

/** 「字幕」子视图：包含原文下展开的「旁白配音」面板（见 `NarrationPanel`）、识别进度提示与字幕列表。 */
function CaptionsView({
  captions,
  locale,
  lines,
  recognizing,
  focusing,
  onFocused,
  onText,
  onRemove,
  onPick,
  lineChip,
  narrationPanel,
  scripts,
}: Pick<
  CaptionsTabProps,
  'captions' | 'locale' | 'recognizing' | 'scripts' | 'onText' | 'onRemove' | 'onPick'
> & {
  /** 当前高亮标注的字幕 ID 集合。 */
  lines: ReadonlySet<string>
  /** 待自动聚焦输入框的字幕 ID（用于新建后立即编辑）。 */
  focusing: string | null
  onFocused: () => void
  /** 某句右上的单句配音标签（译文语言，见 `LineVoiceChip`）；原文语言时是 null。 */
  lineChip: (caption: string) => ReactNode
  /** 原文下展开着的「旁白配音」面板；没展开时是 null。 */
  narrationPanel: ReactNode
}) {
  return (
    <>
      {narrationPanel}
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
              script={scripts.get(caption.id)}
              voiceChip={lineChip(caption.id)}
            />
          ))}
        </ol>
      )}
    </>
  )
}

const NO_VOICES_TEXT = '资料库中暂无音色，请先在资料库的「音频库」中添加音色'
const NO_NARRATION_VOICE_TEXT = '暂无可用音色，无法插入旁白配音；请先在资料库的「音频库」中添加音色'
const NO_NARRATION_TEXT = '旁白文案为空，无法插入旁白配音；请先输入文案'

/**
 * 「旁白配音」展开面板：两行文案输入框、当前音色行（默认资料库的第一个音色，「更换」打开选音面板，见 `CurrentVoice`）以及
 * 底部所选音色与「插入配音与字幕」按钮（合成期间显示「合成中…」）。文案为空、超出字数上限、无可用音色或存在 `blocked` 时
 * 置灰并在点击时说明原因。
 */
function NarrationPanel({
  narration,
  library,
  voice,
  audition,
  onToggle,
  onChange,
}: {
  narration: NarrationControl
  library: VoiceLibrary
  /** 旁白要用的资料库音色；资料库里还没有（或还没读到）音色时是 null。 */
  voice: string | null
  audition: Audition
  onToggle: (audio: ReferenceAudio) => void
  onChange: () => void
}) {
  const [text, setText] = useState('')
  const draft = text.trim()
  const blocked =
    narration.blocked ??
    (voice === null
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
      {voice !== null ? (
        <CurrentVoice
          audition={audition}
          id={voice}
          library={library.voices}
          onChange={onChange}
          onToggle={onToggle}
        />
      ) : library.voices === undefined ? null : (
        <p className="wf-voice-note" role="status">
          {NO_VOICES_TEXT}
        </p>
      )}
      {library.problem === undefined ? null : (
        <InlineAlert
          action={{ label: '重试', onClick: library.problem.onRetry }}
          message={library.problem.message}
        />
      )}
      <div className="wf-narration-foot">
        <span className="wf-narration-voice">
          {voice === null ? null : voiceNameOf(voice, library.voices)}
        </span>
        <BlockedReason reason={blocked}>
          <button
            aria-disabled={blocked === undefined ? undefined : true}
            className="wf-chip-btn is-soft ui-state ui-focus"
            onClick={() => {
              if (blocked === undefined && voice !== null) narration.onInsert(draft, voice)
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
  /** 是否在挂载后自动聚焦并全选该句输入框（用于新建后立即编辑）。 */
  focus: boolean
  onFocused: () => void
  onText: CaptionTextChange
  onRemove: () => void
  onSeek: () => void
  /** 右上角的单句配音标签（译文语言，见 `LineVoiceChip`）；原文语言为 null。 */
  voiceChip: ReactNode
  /** 当前字幕与原始台词存在差异时的台词对照；无差异或无台词时为 `undefined`。 */
  script: ScriptNote | undefined
}

/**
 * 单条字幕卡片：展示起止时间（开着「单独设置」的句子旁边一个小圆点）、单句配音控件（译文语言）、删除按钮、
 * 字幕文本框与台词对照行。
 */
function CaptionRow({
  caption,
  locale,
  current,
  focus,
  onFocused,
  onText,
  onRemove,
  onSeek,
  voiceChip,
  script,
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
        <span className="wf-caption-when">
          <button className="wf-caption-time ui-focus" onClick={onSeek} type="button">
            <Icon decorative name="final-cut-play" size="xs" />
            {range}
          </button>
          {ownsStyle(caption) ? (
            <span
              aria-label={OWN_STYLE_LABEL}
              className="wf-caption-own"
              role="img"
              title={OWN_STYLE_LABEL}
            />
          ) : null}
        </span>
        {voiceChip}
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
      {script === undefined ? null : (
        <ScriptLine
          note={script}
          onUse={() => onText(caption.id, script.script, SOURCE_LOCALE)}
          range={range}
        />
      )}
    </li>
  )
}

/** 为差异对照片段生成稳定列表 key（片段类型与字符起始偏移）。 */
const keyedParts = (parts: ScriptNote['parts']) => {
  let at = 0
  return parts.map((part) => {
    const key = `${part.kind}-${at}`
    at += part.text.length
    return { ...part, key }
  })
}

/**
 * 字幕输入框下方的台词对照行：仅字幕多出的文字加删除线，仅台词存在的文字加下划线；
 * 点击行尾「采用」将当前句字幕替换为对应台词。
 */
function ScriptLine({
  note,
  range,
  onUse,
}: {
  note: ScriptNote
  range: string
  onUse: () => void
}) {
  const parts = keyedParts(note.parts)
  return (
    <p className="wf-caption-source">
      <span className="wf-caption-source-tag">台词</span>
      <span className="wf-caption-script-text">
        {parts.map((part) =>
          part.kind === 'captionOnly' ? (
            <del key={part.key}>{part.text}</del>
          ) : part.kind === 'scriptOnly' ? (
            <ins key={part.key}>{part.text}</ins>
          ) : (
            <Fragment key={part.key}>{part.text}</Fragment>
          ),
        )}
      </span>
      <TooltipRoot>
        <TooltipTrigger asChild>
          <button
            aria-label={`采用 ${range} 的台词`}
            className="wf-caption-script-use ui-state ui-focus"
            onClick={onUse}
            type="button"
          >
            采用
          </button>
        </TooltipTrigger>
        <TooltipContent className="wf-tip" side="top">
          使用台词替换本句字幕
        </TooltipContent>
      </TooltipRoot>
    </p>
  )
}

type CaptionTextFieldProps = {
  caption: CaptionClip
  /** 当前展示语言；切换语言时调用方应以语言代码作为 `key` 重建输入框，确保未提交草稿写回原语言。 */
  locale: ShownLocale
  onText: CaptionTextChange
  className: string
  ref?: Ref<HTMLTextAreaElement>
  id?: string
  'aria-label'?: string
}

/**
 * 字幕文本输入框（「字幕」页签与「属性」共用）：回车换行，停顿 300 毫秒后提交变更（见 `usePausedCommit`）。
 * 译文语言下编辑该语言译文（未译时为空并展示占位提示），下方附带原文对照。
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
