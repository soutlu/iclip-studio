import { Fragment, useEffect, useId, useRef, useState, type ComponentProps, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { AudioCover, type Audition } from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from '../components/blocked-reason'
import { captionClock, captionsInOrder, type CaptionsView } from './caption-edit'
import type { ScriptNote } from './caption-script'
import { ComponentTexts } from './component-texts'
import { ownsStyle } from './composition/captions'
import type { AudioClip, CaptionClip } from './composition/film'
import { LocaleBar, type LocaleControls } from './editor-toolbar'
import { EmptyNote } from './empty-note'
import { LineTools, type LineVoiceProps } from './line-voice'
import { RowProgress } from './media-row'
import {
  captionIn,
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  type Language,
  type ShownLocale,
} from './locales'
import { usePausedCommit } from './use-paused-commit'
import { voiceCoverOf, voiceTitleOf, type VoiceControl, type VoiceLibrary } from './voice-choices'
import { speedText } from './voice-lines'
import type { VoicePickTarget } from './voice-picker'

const ADD_LABEL = '在播放头处添加字幕'
const RECOGNIZE_LABEL = '识别'
const TRANSLATE_LABEL = '翻译'
const OWN_STYLE_LABEL = '已单独设置样式'
const DUB_AUDITION = 'dub:'

/** 单句试听在共用试听里的编号：按配音片段算，重配后换了片段就是另一条。 */
const dubAuditionId = (dubId: string) => `${DUB_AUDITION}${dubId}`

/** 修改指定字幕在目标语言 `locale` 下的文本（见 `useFilmSession` 的 `setCaptionText`）。 */
export type CaptionTextChange = (id: string, text: string, locale: Language) => void

/** 译文语言下的「翻译」控制：包含禁用原因与翻译进行中状态。 */
type TranslateControl = {
  blocked: string | undefined
  translating: boolean
  onTranslate: () => void
}

type CaptionsTabProps = {
  /** 译文语言下的「翻译」控制；原文语言时为 `undefined`（不展示）。 */
  translate: TranslateControl | undefined
  /** 当前语言（原文也是）的人声设置和配音；工程还没打开时是 undefined。 */
  voice: VoiceControl | undefined
  /** 资料库音色：默认音色和单句音色从这里找名字和封面。 */
  library: VoiceLibrary
  /** 当前语言下各句的配音片段（字幕编号 → 片段），单句试听放它。 */
  dubs: ReadonlyMap<string, AudioClip>
  /** 右栏共用的试听（单句试听、选音浮层的样音同一时间只放一条）。 */
  audition: Audition
  /** 选音浮层正在给谁选；没开时是 null。 */
  picking: VoicePickTarget | null
  /** 打开选音浮层，贴着 `anchor` 弹（见 `VoicePicker`）。 */
  onPickVoice: (pick: VoicePickTarget, anchor: HTMLElement) => void
  /** 每变一次就切回「字幕」视图（导出提醒里的「去重配」）。 */
  showCaptions: number
  captions: readonly CaptionClip[]
  /** 「画面文字」视图配置（与当前展示语言及选中片段共享状态）。 */
  texts: Omit<ComponentProps<typeof ComponentTexts>, 'locale' | 'selected'>
  /** 当前展示语言：译文语言下输入框编辑译文，并在下方附带原文参考。 */
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
  /** 无法触发字幕识别时的禁用原因；非空时置灰「识别」并在点击时提示。 */
  recognizeBlocked: string | undefined
  /** 识别结果提示，有值时在「识别」旁展示；收起时调用 `onRecognizeNoteClose`。 */
  recognizeNote: string | undefined
  onRecognizeNoteClose: () => void
  onRecognize: () => void
  /** 与原始台词存在差异的字幕映射（字幕 ID → 台词对照），在该句文字下方展示（见 `useCaptionScripts`）。 */
  scripts: ReadonlyMap<string, ScriptNote>
  /** 字幕文件结构异常提示，置顶展示。 */
  problem: string | undefined
  /** 在播放头处新增一句字幕并返回新字幕 ID；未成功添加时返回 `undefined`。 */
  onAdd: () => Promise<string | undefined>
  onText: CaptionTextChange
  onRemove: (id: string) => void
  /** 点击字幕时间按钮：选中该字幕并将播放头跳转至其起始时刻。 */
  onPick: (caption: CaptionClip) => void
  /** 点一句的空白处：只选中它（和时间线、画布同步），不跳播。 */
  onSelect: (caption: CaptionClip) => void
}

/**
 * 「字幕」页签：顶部两排固定工具区，下面逐句编辑的列表。
 * - 第一排：左边语言条（见 `LocaleBar`），右边「字幕 N | 画面文字 N」。
 * - 第二排（「字幕」视图）：左边「原声 | 配音」，配音时紧跟默认音色胶囊（点了弹选音浮层）；右边原文下「识别」、外语下
 *   「翻译」，配音时的合成主按钮（见 `DubButton`），最右「+」在播放头处加一句并聚焦它。「画面文字」视图下原文没有第二排，
 *   外语只有右对齐的「翻译」。
 * - 列表每句一行（不画框，底色区分悬停、选中、编辑、试听）：时间、倍速标记、右侧按意图显露的按钮（见 `LineTools`），
 *   下面原地编辑的文字、单句试听进度条、外语下的原文参考和原文下的台词对照。
 *
 * 视图随选区变化自动跟随：选中字幕或配音时切至「字幕」，选中含文字的元素/模板片段时切至「画面文字」；
 * 用户手动切换视图后保持选择，直至下次选区发生变化。
 */
export function CaptionsTab({
  translate,
  voice,
  library,
  dubs,
  audition,
  picking,
  onPickVoice,
  showCaptions,
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
  onSelect,
}: CaptionsTabProps) {
  const [focusing, setFocusing] = useState<string | null>(null)
  const [view, setView] = useState<CaptionsView>(focus.view ?? 'captions')
  const selectionKey = [...selected].sort().join(' ')
  const [seenSelection, setSeenSelection] = useState(selectionKey)
  if (selectionKey !== seenSelection) {
    setSeenSelection(selectionKey)
    if (focus.view !== undefined) setView(focus.view)
  }
  const [seenShow, setSeenShow] = useState(showCaptions)
  if (showCaptions !== seenShow) {
    setSeenShow(showCaptions)
    setView('captions')
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
  const dubbing = voice?.mode === 'dub'
  // 正在单句试听的那一句不在列表里了（换了语言、切到「画面文字」、删了这句、重配换了片段）时停下，免得声音没处停
  const listed = onCaptions
    ? captions.flatMap((caption) => {
        const dub = dubs.get(caption.id)
        return dub === undefined ? [] : [dubAuditionId(dub.id)]
      })
    : []
  const orphaned =
    audition.current !== null &&
    audition.current.startsWith(DUB_AUDITION) &&
    !listed.includes(audition.current)
  useEffect(() => {
    if (orphaned) audition.stop()
  }, [orphaned, audition])
  const textAction =
    translate !== undefined ? (
      <TranslateButton translate={translate} />
    ) : onCaptions ? (
      <RecognizeButton
        blocked={recognizeBlocked}
        note={recognizeNote}
        onNoteClose={onRecognizeNoteClose}
        onRecognize={onRecognize}
        recognizing={recognizing}
      />
    ) : null

  return (
    <div className="wf-captions">
      <div className="wf-tab-head wf-captions-head">
        <div className="wf-captions-row">
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
        {onCaptions ? (
          <div className="wf-captions-row">
            <div className="wf-captions-voice">
              {voice === undefined ? null : (
                <>
                  <div aria-label="原声或配音" className="wf-seg" role="group">
                    {(['original', 'dub'] as const).map((mode) => (
                      <button
                        aria-pressed={voice.mode === mode}
                        className="wf-seg-item ui-state ui-focus"
                        key={mode}
                        onClick={() => {
                          if (voice.mode !== mode) voice.onMode(mode)
                        }}
                        type="button"
                      >
                        {mode === 'original' ? '原声' : '配音'}
                      </button>
                    ))}
                  </div>
                  {dubbing ? (
                    <DefaultVoice
                      library={library}
                      onPick={(anchor) => onPickVoice({ target: 'language' }, anchor)}
                      open={picking?.target === 'language'}
                      voice={voice.voice}
                    />
                  ) : null}
                </>
              )}
            </div>
            <div className="wf-captions-acts">
              {textAction}
              {dubbing && voice !== undefined ? <DubButton voice={voice} /> : null}
              <AddLineButton blocked={addBlocked} onAdd={() => void add()} />
            </div>
          </div>
        ) : translate === undefined ? null : (
          <div className="wf-captions-row">
            <div className="wf-captions-acts">{textAction}</div>
          </div>
        )}
      </div>
      {problem === undefined ? null : (
        <InlineAlert className="wf-captions-alert" message={problem} />
      )}
      {onCaptions ? (
        <CaptionsView
          audition={audition}
          captions={captions}
          dubs={dubs}
          focusing={focusing}
          library={library}
          lines={focus.lines}
          locale={locale}
          onFocused={() => setFocusing(null)}
          onPick={onPick}
          onPickVoice={onPickVoice}
          onRemove={onRemove}
          onSelect={onSelect}
          onText={onText}
          picking={picking}
          recognizing={recognizing}
          scripts={scripts}
          voice={voice}
        />
      ) : (
        <ComponentTexts {...texts} locale={locale} selected={selected} />
      )}
    </div>
  )
}

/** 配音时第二排的默认音色胶囊：小封面、名字（放不下时截断）和 ⌄，点了弹选音浮层。 */
function DefaultVoice({
  voice,
  library,
  open,
  onPick,
}: {
  voice: string | null
  library: VoiceLibrary
  open: boolean
  onPick: (anchor: HTMLElement) => void
}) {
  const name = voiceTitleOf(voice, library.voices)
  const cover = voiceCoverOf(voice, library.voices)
  return (
    <button
      aria-label={`默认音色：${name}`}
      className="wf-select wf-voice-pill ui-state ui-focus"
      data-state={open ? 'open' : undefined}
      onClick={(event) => onPick(event.currentTarget)}
      type="button"
    >
      {cover === undefined ? (
        <Icon decorative name="final-cut-voice" size="sm" />
      ) : (
        <AudioCover {...cover} size="xs" state="idle" title={name} />
      )}
      <span className="wf-voice-pill-name">{name}</span>
      <Icon decorative name="final-cut-expand" size="xs" />
    </button>
  )
}

/**
 * 配音时的合成主按钮，按这种语言的汇总变：合成中是转圈和还剩几句（不能点）；一句都没配过是「生成配音」；有待处理的是
 * 「重配 N 句」（只合成它们）；全部最新时收成一个「重新生成」图标按钮。右栏放不下时只留图标和数字（读屏名不变）。
 */
function DubButton({ voice }: { voice: VoiceControl }) {
  const { summary, generate, fill } = voice
  if (summary.running > 0)
    return (
      <span
        aria-label={`正在生成配音，还剩 ${summary.running} 句`}
        className="wf-chip-btn is-soft wf-dub-main"
        role="status"
      >
        <Icon className="animate-spin" decorative name="spinner" size="sm" />
        <span className="wf-dub-word">还剩 </span>
        {summary.running}
        <span className="wf-dub-word"> 句</span>
      </span>
    )
  if (summary.dubbed && summary.pending === 0)
    return (
      <BlockedReason reason={generate.blocked}>
        <IconButton
          aria-disabled={generate.blocked === undefined ? undefined : true}
          label="重新生成"
          name="final-cut-reset"
          onClick={generate.run}
          size="sm"
          tooltip={generate.blocked === undefined ? '重新生成这种语言的全部配音' : undefined}
        />
      </BlockedReason>
    )
  const first = !summary.dubbed
  const action = first ? generate : fill
  return (
    <BlockedReason reason={action.blocked}>
      <button
        aria-disabled={action.blocked === undefined ? undefined : true}
        aria-label={first ? '生成配音' : `重配 ${summary.pending} 句`}
        className="wf-chip-btn is-soft wf-dub-main ui-state ui-focus"
        onClick={action.run}
        type="button"
      >
        <Icon decorative name={first ? 'final-cut-generate' : 'final-cut-reset'} size="sm" />
        {first ? (
          <span className="wf-dub-word">生成配音</span>
        ) : (
          <>
            <span className="wf-dub-word">重配 </span>
            {summary.pending}
            <span className="wf-dub-word"> 句</span>
          </>
        )}
      </button>
    </BlockedReason>
  )
}

function TranslateButton({ translate }: { translate: TranslateControl }) {
  return (
    <BlockedReason reason={translate.blocked}>
      <button
        aria-disabled={translate.blocked === undefined ? undefined : true}
        className="wf-chip-btn is-tonal ui-state ui-focus"
        onClick={() => {
          if (translate.blocked === undefined) translate.onTranslate()
        }}
        type="button"
      >
        <Icon decorative name="final-cut-translate" size="sm" />
        {translate.translating ? '翻译中…' : TRANSLATE_LABEL}
      </button>
    </BlockedReason>
  )
}

/**
 * 第二排最右侧的「+」按钮：在播放头处新增一句字幕。悬停展示功能名；不可用时置灰并在悬停及点击时说明原因
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
 * 「识别」按钮。不可用时置灰，悬停或点击说明原因（同 `BlockedReason`）；`note` 有值时在按钮旁展示识别结果提示，
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
          className="wf-chip-btn is-tonal ui-state ui-focus"
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

type CaptionsViewProps = Pick<
  CaptionsTabProps,
  | 'captions'
  | 'locale'
  | 'recognizing'
  | 'scripts'
  | 'onText'
  | 'onRemove'
  | 'onPick'
  | 'onSelect'
  | 'voice'
  | 'library'
  | 'dubs'
  | 'audition'
  | 'picking'
  | 'onPickVoice'
> & {
  /** 当前高亮标注的字幕 ID 集合。 */
  lines: ReadonlySet<string>
  /** 待自动聚焦输入框的字幕 ID（用于新建后立即编辑）。 */
  focusing: string | null
  onFocused: () => void
}

/** 「字幕」子视图：识别进度提示与字幕列表。 */
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
  onSelect,
  scripts,
  voice,
  library,
  dubs,
  audition,
  picking,
  onPickVoice,
}: CaptionsViewProps) {
  return (
    <>
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
          {captionsInOrder(captions).map((caption) => {
            const dub = dubs.get(caption.id)
            const auditionId = dubAuditionId(dub?.id ?? caption.id)
            const state = voice?.lines.get(caption.id)
            return (
              <CaptionRow
                audition={audition}
                auditionId={auditionId}
                caption={caption}
                current={lines.has(caption.id)}
                dub={
                  voice === undefined || state === undefined
                    ? undefined
                    : {
                        state,
                        voice,
                        library: library.voices,
                        hasDub: dub !== undefined,
                        auditioning: audition.playing === auditionId,
                        onAudition: () => {
                          if (dub === undefined) return
                          const mediaMs = dub.duration * dub.playbackRate
                          audition.toggle(auditionId, dub.src, {
                            startMs: dub.mediaStart,
                            endMs: dub.mediaStart + mediaMs,
                            rate: dub.playbackRate,
                          })
                        },
                        picking: picking?.target === 'line' && picking.caption === caption.id,
                        onPickVoice: (anchor) =>
                          onPickVoice({ target: 'line', caption: caption.id }, anchor),
                      }
                }
                durationMs={dub === undefined ? 0 : dub.duration}
                focus={caption.id === focusing}
                key={caption.id}
                locale={locale}
                onFocused={onFocused}
                onRemove={() => onRemove(caption.id)}
                onSeek={() => onPick(caption)}
                onSelect={() => onSelect(caption)}
                onText={onText}
                script={scripts.get(caption.id)}
              />
            )
          })}
        </ol>
      )}
    </>
  )
}

type CaptionRowProps = {
  caption: CaptionClip
  locale: ShownLocale
  current: boolean
  /** 是否在挂载后自动聚焦并全选该句输入框（用于新建后立即编辑），并滚到看得见的地方。 */
  focus: boolean
  onFocused: () => void
  onText: CaptionTextChange
  onRemove: () => void
  onSeek: () => void
  onSelect: () => void
  /** 配音按钮要用的（见 `LineTools`）；工程还没打开时是 undefined。 */
  dub: LineVoiceProps | undefined
  audition: Audition
  /** 这句单句试听在共用试听里的编号。 */
  auditionId: string
  /** 这句配音片段的时长（毫秒），读到音频前进度条按它算。 */
  durationMs: number
  /** 当前字幕与原始台词存在差异时的台词对照；无差异或无台词时为 `undefined`。 */
  script: ScriptNote | undefined
}

/** 倍速标记的悬停说明。 */
const speedTip = (text: string, trimmed: boolean) =>
  trimmed
    ? '配音加速到上限仍超出本句时长，已截掉结尾；请精简文字或拉长字幕'
    : `配音比本句时长长，已加速到 ${text} 播放`

/**
 * 一句字幕：不画框，底色区分悬停、选中、编辑、试听（见 `.wf-row`）。头一行是时间（点了跳到这句开头）、倍速标记和
 * 开着「单独设置」时的小圆点，右边按钮（见 `LineTools`）；下面原地编辑的文字，单句试听时展开进度条，外语下一行原文参考，
 * 原文下和台词不一样时一行台词对照。点行里空白处只选中这句。
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
  onSelect,
  dub,
  audition,
  auditionId,
  durationMs,
  script,
}: CaptionRowProps) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!focus) return
    fieldRef.current?.focus()
    fieldRef.current?.select()
    fieldRef.current?.scrollIntoView({ block: 'nearest' })
    onFocused()
  }, [focus, onFocused])

  const range = `${captionClock(caption.start)} – ${captionClock(caption.start + caption.duration)}`
  const listening = audition.current === auditionId
  const state = dub?.state
  const speed =
    state === undefined || state.speed === null || state.status === 'original'
      ? undefined
      : speedText(state.speed, state.trimmed)
  return (
    <li
      aria-current={current ? 'true' : undefined}
      className={cn('wf-row wf-reveal-host wf-caption-row', (current || listening) && 'is-current')}
    >
      <button
        aria-label={`选中 ${range} 的字幕`}
        className="wf-row-hit"
        onClick={onSelect}
        tabIndex={-1}
        type="button"
      />
      <div className="wf-caption-head">
        <span className="wf-caption-when">
          <button className="wf-caption-time ui-focus" onClick={onSeek} type="button">
            <Icon decorative name="final-cut-play" size="xs" />
            {range}
          </button>
          {speed === undefined || state === undefined ? null : (
            <TooltipRoot>
              <TooltipTrigger asChild>
                <span
                  className="wf-caption-speed"
                  data-tone={state.trimmed ? 'warning' : undefined}
                >
                  {speed}
                </span>
              </TooltipTrigger>
              <TooltipContent className="wf-tip" side="top">
                {speedTip(speed, state.trimmed)}
              </TooltipContent>
            </TooltipRoot>
          )}
          {ownsStyle(caption) ? (
            <span
              aria-label={OWN_STYLE_LABEL}
              className="wf-caption-own"
              role="img"
              title={OWN_STYLE_LABEL}
            />
          ) : null}
        </span>
        <LineTools
          caption={caption.id}
          dub={dub}
          remove={
            <IconButton
              className="wf-caption-remove"
              label={`删除 ${range} 的字幕`}
              name="final-cut-delete"
              onClick={onRemove}
              size="xs"
            />
          }
        />
      </div>
      <LineText
        audition={audition}
        caption={caption}
        durationMs={durationMs}
        key={locale.code}
        label={`字幕文字 ${range}`}
        listening={listening}
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

/**
 * 一句的文字：看着就是正文，点了原地改（静止、悬停、聚焦时字的位置和行高都不变），停顿 300 毫秒后提交（见
 * `usePausedCommit`）。没字时是柔和内凹的占位槽：外语写「+ 输入译文，或点上方「翻译」自动生成」，原文写「+ 输入字幕」。
 * 下面依次是单句试听时展开的进度条、外语下浅色的原文参考。切换语言时调用方应以语言代码作为 `key` 重建，未提交的草稿
 * 写回原语言。
 */
function LineText({
  caption,
  locale,
  onText,
  label,
  audition,
  listening,
  durationMs,
  ref,
}: {
  caption: CaptionClip
  locale: ShownLocale
  onText: CaptionTextChange
  label: string
  audition: Audition
  listening: boolean
  durationMs: number
  ref: Ref<HTMLTextAreaElement>
}) {
  const { draft, fieldProps } = usePausedCommit((text) => onText(caption.id, text, locale.code))
  const sourceId = useId()
  const foreign = locale.values !== null
  return (
    <>
      <Textarea
        {...fieldProps}
        aria-describedby={foreign ? sourceId : undefined}
        aria-label={label}
        className="wf-caption-text"
        placeholder={foreign ? '+ 输入译文，或点上方「翻译」自动生成' : '+ 输入字幕'}
        ref={ref}
        rows={1}
        value={draft ?? captionIn(locale, caption).text}
      />
      <RowProgress
        audition={audition}
        current={listening}
        durationMs={durationMs}
        label={`本句配音播放进度：${caption.text}`}
      />
      {foreign ? (
        <p className="wf-caption-ref" id={sourceId}>
          {/* 看得出是原文参考，读屏时补上「原文」 */}
          <span className="sr-only">{SOURCE_NAME}</span> {caption.text}
        </p>
      ) : null}
    </>
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
 * 字幕文字下方的台词对照行（和原文参考同一种浅色小字）：仅字幕多出的文字加删除线，仅台词存在的文字加下划线；
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
    <p className="wf-caption-ref wf-caption-script">
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
 * 「属性」里字幕的文本输入框：回车换行，停顿 300 毫秒后提交变更（见 `usePausedCommit`）。
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
