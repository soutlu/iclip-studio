import { Fragment, useEffect, useId, useRef, useState, type ComponentProps, type Ref } from 'react'
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
import type { ScriptNote } from './caption-script'
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

const ADD_LABEL = '在播放头处添加字幕'
const RECOGNIZE_LABEL = '识别字幕'
const TRANSLATE_LABEL = '翻译'
const NARRATION_LABEL = '旁白配音'
const INSERT_NARRATION_LABEL = '插入配音与字幕'
const AUDITION_FAILED_TEXT = '音色试听失败，请重试'

/** 修改指定字幕在目标语言 `locale` 下的文本（见 `useFilmSession` 的 `setCaptionText`）。 */
export type CaptionTextChange = (id: string, text: string, locale: Language) => void

/** 译文语言下的「翻译」控制：包含禁用原因与翻译进行中状态。 */
type TranslateControl = {
  blocked: string | undefined
  translating: boolean
  onTranslate: () => void
}

/** 参考音频库中的音色条目：标识、名称与试听音频地址。 */
export type VoiceOption = { id: string; name: string; url: string }

/** 音色列表加载失败原因及重试回调。 */
type VoicesProblem = { message: string; onRetry: () => void }

/**
 * 译文语言下的人声配置与控制：`mode` 为当前人声模式，`voice` 为该语言默认配音音色（`null` 表示沿用原声音色），
 * `voices` 与 `voicesProblem` 为资料库可用音色及其加载错误；`dubbed` 标识是否已有配音片段，
 * `generating` / `narrating` 分别记录在途的素材片配音数与旁白合成数（空闲时为 0）；
 * `generateBlocked` / `redoBlocked` 为换音色生成与重新生成的禁用原因；`lines` 与 `lineBlocked` 为单句级覆盖配置及禁用原因。
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
  /** 切换当前语言默认音色（`null` 表示原声音色）并重配跟随默认音色的字幕句（已有配音时替换）。 */
  onGenerate: (voice: string | null) => void
  /** 按各句当前配置的音色重新生成全部待配音句子的配音。 */
  onRedo: () => void
  /**
   * 修改单句配音配置（传 `null` 恢复跟随整体音色）：选定音色时仅重配该句（实际音色未变且已有配音时仅更新配置），
   * 设为不配音时移除对应配音片段。
   */
  onLine: (caption: string, line: LineVoice | null) => void
}

/**
 * 原文语言下的「旁白配音」面板控制：`open` 为展开状态，`voices` 与 `voicesProblem` 为资料库音色列表及加载错误；
 * `generating` 标识正在合成旁白，`blocked` 为除文案与音色外的外部阻断原因。
 */
export type NarrationControl = {
  open: boolean
  onOpen: (open: boolean) => void
  voices: readonly VoiceOption[] | undefined
  voicesProblem: VoicesProblem | undefined
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
  captions: readonly CaptionClip[]
  /** 「组件文字」视图配置（与当前展示语言及选中片段共享状态）。 */
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
 * 「字幕」页签：顶栏左侧为语言切换（见 `LocaleBar`），右侧在「字幕」与「组件文字」（见 `ComponentTexts`）间切换并附数量统计；
 * 次行为操作栏：包含译文语言的「翻译」（统一翻译两视图未译项）、「字幕」视图的「识别字幕」、原文语言的「旁白配音」（展开见 `NarrationPanel`）
 * 及右侧在播放头处新增字幕的「+」。列表按起始时间排序，支持直接编辑、删除及点击时间定位；
 * 选中字幕或对应配音片段时高亮当前句，新增字幕自动聚焦输入框；译文语言下顶部额外展示人声配置卡（见 `VoiceCard`）。
 *
 * 视图随选区变化自动跟随：选中字幕或配音时切至「字幕」，选中含文字贴片/场景时切至「组件文字」；
 * 用户手动切换视图后保持选择，直至下次选区发生变化。
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
          scripts={scripts}
          voice={voice}
        />
      ) : (
        <ComponentTexts {...texts} locale={locale} selected={selected} />
      )}
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

const GENERATING_TEXT = '正在生成配音，请等待生成完成'

const ORIGINAL_VOICE = '原声'

/** 存在在途配音生成任务（素材片或旁白）时返回阻断文案。 */
const busyOf = ({ generating, narrating }: Pick<VoiceControl, 'generating' | 'narrating'>) =>
  generating + narrating > 0 ? GENERATING_TEXT : undefined

/**
 * 译文语言下的人声配置卡片：顶栏包含「人声」标题、「保留原声」及已有配音时的「重新生成」按钮；
 * 下方列出可选 AI 配音音色（「原声」居首，随后为支持试听的资料库音色）。「保留原声」与所选音色互斥高亮。
 * 选择某音色时：若当前语言已有该音色的既有配音则直接切入配音模式，否则将其设为当前语言默认音色并重配跟随默认音色的句子。
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
  /** 不可选时的禁用原因；非空时置灰并在点击时提示。 */
  blocked: string | undefined
  onPick: () => void
  /** 资料库音色的试听控制；「原声」不提供试听。 */
  audition?: { playing: boolean; onToggle: () => void }
}

/** 单个音色胶囊：左侧为可选试听按钮，右侧为音色名称选择按钮。 */
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
// 已选音色已从资料库移除或尚未加载时的兜底展示名
const LIBRARY_VOICE_NAME = '资料库音色'

/** 将菜单选项值转换为单句配音覆盖配置（`null` 表示跟随整体音色）。 */
const lineVoiceOfValue = (value: string): LineVoice | null =>
  value === FOLLOW
    ? null
    : value === UNVOICED
      ? { dub: false }
      : { voice: value === ORIGINAL ? null : value.slice('voice:'.length) }

/** 将单句配音覆盖配置映射为菜单选中值。 */
const valueOfLineVoice = (line: LineVoice | undefined): string =>
  line === undefined
    ? FOLLOW
    : 'dub' in line
      ? UNVOICED
      : line.voice === null
        ? ORIGINAL
        : `voice:${line.voice}`

/**
 * 译文语言下单句字幕的配音状态控件：保留原声时渲染只读「原声」标签；AI 配音模式下展示本句实际音色或「不配音」
 * （显式单独配置与跟随整体音色在视觉上区分），点击弹出单选菜单切换配置；不可配音或生成中置灰并说明原因。
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
      {/* 菜单展开时抑制 Tooltip，避免与菜单重叠 */}
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

/** 「字幕」子视图：包含原文下展开的「旁白配音」面板（见 `NarrationPanel`）、识别进度提示与字幕列表。 */
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
  scripts,
}: Pick<
  CaptionsTabProps,
  | 'active'
  | 'onNotice'
  | 'captions'
  | 'locale'
  | 'recognizing'
  | 'scripts'
  | 'onText'
  | 'onRemove'
  | 'onPick'
  | 'voice'
  | 'narration'
> & {
  /** 当前高亮标注的字幕 ID 集合。 */
  lines: ReadonlySet<string>
  /** 待自动聚焦输入框的字幕 ID（用于新建后立即编辑）。 */
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
              script={scripts.get(caption.id)}
              voice={voice}
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
 * 「旁白配音」展开面板：包含两行文案输入框、可试听的资料库音色列表（默认选中首个音色）以及底部所选音色与「插入配音与字幕」按钮
 * （合成期间显示「合成中…」）。文案为空、超出字数上限、无可用音色或存在 `blocked` 时置灰并在点击时说明原因。
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
  /** 是否在挂载后自动聚焦并全选该句输入框（用于新建后立即编辑）。 */
  focus: boolean
  onFocused: () => void
  onText: CaptionTextChange
  onRemove: () => void
  onSeek: () => void
  /** 译文语言下的人声配置（右上角附单句配音控件，见 `LineVoiceChip`）；原文语言为 `undefined`。 */
  voice: VoiceControl | undefined
  /** 当前字幕与原始台词存在差异时的台词对照；无差异或无台词时为 `undefined`。 */
  script: ScriptNote | undefined
}

/** 单条字幕卡片：展示起止时间、单句配音控件（译文语言）、删除按钮、字幕文本框与台词对照行。 */
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
