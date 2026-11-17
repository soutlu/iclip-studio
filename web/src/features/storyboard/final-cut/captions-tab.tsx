import { useEffect, useId, useRef, useState, type ComponentProps, type Ref } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { BlockedReason } from '../components/blocked-reason'
import { captionClock, captionsInOrder } from './caption-edit'
import { ComponentTexts } from './component-texts'
import type { CaptionClip } from './composition/film'
import type { VoiceMode } from './composition/voices'
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

/** 改一句字幕在语言 `locale` 里的字（见 `useFilmSession` 的 `setCaptionText`）。 */
export type CaptionTextChange = (id: string, text: string, locale: Language) => void

/** 其它语言下的「翻译」：为什么现在不能点（给了就置灰，点了说明它），是不是在翻译中。 */
type TranslateControl = {
  blocked: string | undefined
  translating: boolean
  onTranslate: () => void
}

/**
 * 其它语言下的人声设置：`mode` 是现在的设置，`dubbed` 是这种语言已经有配音片段，`generating` 是正在给几条
 * 素材片生成配音（没在生成时是 0），`generateBlocked` 是现在为什么不能生成配音。
 */
export type VoiceControl = {
  mode: VoiceMode
  dubbed: boolean
  generating: number
  generateBlocked: string | undefined
  onMode: (mode: VoiceMode) => void
  /** 生成这种语言的配音（已有配音时换掉）。 */
  onGenerate: () => void
}

type CaptionsTabProps = {
  /** 其它语言下的「翻译」；原文时是 undefined，不显示。 */
  translate: TranslateControl | undefined
  /** 其它语言下的人声设置；原文时是 undefined，不显示。 */
  voice: VoiceControl | undefined
  captions: readonly CaptionClip[]
  /** 「组件文字」那一段（显示着的语言、选中的片段和这里共用）。 */
  texts: Omit<ComponentProps<typeof ComponentTexts>, 'locale' | 'selected'>
  /** 显示着的语言：其它语言时文字框里是这种语言的字，旁边写着原文。 */
  locale: ShownLocale
  /** 编辑器里选中的片段：选中的字幕在列表里标出来。 */
  selected: ReadonlySet<string>
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
 * 「字幕·配音」页签：最上面在「字幕」和「组件文字」（见 `ComponentTexts`）两段之间切换，各写着有几个。「字幕」是识别
 * 字幕、在播放头处加一句，下面是按开始时间排的字幕列表，每句能直接改字、删掉，点时间选中它、跳到它的开始。
 * 编辑器里选中的字幕标成当前这一句；刚加的那一句焦点进它的文字框。识别中写着在识别几个片段。其它语言下改的是
 * 这种语言的字，最上面多一个「翻译」，两段里还没翻的一起翻；「字幕」里多一行人声设置（见 `VoiceRow`）。
 */
export function CaptionsTab({
  translate,
  voice,
  captions,
  texts,
  locale,
  selected,
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
  const [view, setView] = useState<'captions' | 'texts'>('captions')
  const add = async () => {
    if (addBlocked !== undefined) return
    const id = await onAdd()
    if (id !== undefined) setFocusing(id)
  }
  const views = [
    { value: 'captions', label: '字幕', count: captions.length },
    { value: 'texts', label: '组件文字', count: texts.hosts.length },
  ] as const
  return (
    <div className="wf-captions">
      {problem === undefined ? null : (
        <InlineAlert className="wf-captions-alert" message={problem} />
      )}
      {translate === undefined ? null : (
        <div className="wf-captions-actions wf-captions-translate">
          <BlockedReason reason={translate.blocked}>
            <Button
              aria-disabled={translate.blocked === undefined ? undefined : true}
              className="wf-captions-action"
              leadingIcon="sparkles"
              onClick={() => {
                if (translate.blocked === undefined) translate.onTranslate()
              }}
              size="md"
              variant="outlined"
            >
              {translate.translating ? '翻译中…' : TRANSLATE_LABEL}
            </Button>
          </BlockedReason>
        </div>
      )}
      <div aria-label="字幕或组件文字" className="wf-captions-views" role="group">
        {views.map((each) => (
          <button
            aria-pressed={view === each.value}
            className="wf-captions-view ui-state ui-focus"
            key={each.value}
            onClick={() => setView(each.value)}
            type="button"
          >
            {each.label} <span className="wf-captions-count">{each.count}</span>
          </button>
        ))}
      </div>
      {view === 'captions' && voice !== undefined ? <VoiceRow voice={voice} /> : null}
      {view === 'texts' ? (
        <ComponentTexts {...texts} locale={locale} selected={selected} />
      ) : (
        <CaptionsView
          add={add}
          addBlocked={addBlocked}
          captions={captions}
          focusing={focusing}
          locale={locale}
          onFocused={() => setFocusing(null)}
          onPick={onPick}
          onRecognize={onRecognize}
          onRemove={onRemove}
          onText={onText}
          recognizeBlocked={recognizeBlocked}
          recognizing={recognizing}
          selected={selected}
        />
      )}
    </div>
  )
}

const GENERATING_TEXT = '正在生成配音，请等待生成完成'

/**
 * 其它语言下的「人声」一行：「保留原声」和「AI 配音」二选一，当前的高亮。这种语言还没有配音时点「AI 配音」是生成
 * 配音（生成完自动用上），有配音时是切过去；有配音时旁边多一个「重新生成」。生成中写着在给几条素材片配音。
 */
function VoiceRow({ voice }: { voice: VoiceControl }) {
  const { mode, dubbed, generating, generateBlocked, onMode, onGenerate } = voice
  const busy = generating > 0 ? GENERATING_TEXT : undefined
  const redoBlocked = busy ?? generateBlocked
  const dubBlocked = dubbed ? busy : redoBlocked
  return (
    <>
      <div aria-label="人声设置" className="wf-captions-voice" role="group">
        <span className="wf-captions-voice-label">人声</span>
        <button
          aria-pressed={mode === 'original'}
          className="wf-captions-voice-mode ui-state ui-focus"
          onClick={() => onMode('original')}
          type="button"
        >
          保留原声
        </button>
        <BlockedReason reason={dubBlocked}>
          <button
            aria-disabled={dubBlocked === undefined ? undefined : true}
            aria-pressed={mode === 'dub'}
            className="wf-captions-voice-mode ui-state ui-focus"
            onClick={() => {
              if (dubBlocked !== undefined) return
              if (dubbed) onMode('dub')
              else onGenerate()
            }}
            type="button"
          >
            {generating > 0 ? '配音中…' : 'AI 配音'}
          </button>
        </BlockedReason>
        {dubbed ? (
          <BlockedReason reason={redoBlocked}>
            <button
              aria-disabled={redoBlocked === undefined ? undefined : true}
              className="wf-captions-voice-redo ui-state ui-focus"
              onClick={() => {
                if (redoBlocked === undefined) onGenerate()
              }}
              type="button"
            >
              重新生成
            </button>
          </BlockedReason>
        ) : null}
      </div>
      {generating > 0 ? (
        <p className="wf-captions-note" role="status">
          正在为 {generating} 条素材片生成配音，可继续编辑
        </p>
      ) : null}
    </>
  )
}

/** 「字幕」那一段：识别、加一句的按钮和字幕列表。 */
function CaptionsView({
  captions,
  locale,
  selected,
  addBlocked,
  recognizing,
  recognizeBlocked,
  onRecognize,
  add,
  focusing,
  onFocused,
  onText,
  onRemove,
  onPick,
}: Omit<CaptionsTabProps, 'texts' | 'problem' | 'onAdd' | 'translate' | 'voice'> & {
  add: () => Promise<void>
  /** 焦点要进的那一句（刚加的）。 */
  focusing: string | null
  onFocused: () => void
}) {
  return (
    <>
      <div className="wf-captions-actions">
        <BlockedReason reason={recognizeBlocked}>
          <Button
            aria-disabled={recognizeBlocked === undefined ? undefined : true}
            className="wf-captions-action wf-captions-recognize"
            leadingIcon="waveform"
            onClick={() => {
              if (recognizeBlocked === undefined) onRecognize()
            }}
            size="md"
            variant="inverted"
          >
            {recognizing > 0 ? '识别中…' : RECOGNIZE_LABEL}
          </Button>
        </BlockedReason>
        <BlockedReason reason={addBlocked}>
          <Button
            aria-disabled={addBlocked === undefined ? undefined : true}
            className="wf-captions-action"
            leadingIcon="add"
            onClick={() => void add()}
            size="md"
            variant="outlined"
          >
            {ADD_LABEL}
          </Button>
        </BlockedReason>
      </div>
      {recognizing > 0 ? (
        <p className="wf-captions-note" role="status">
          正在识别 {recognizing} 个视频片段的字幕，可继续编辑
        </p>
      ) : null}
      {captions.length === 0 ? (
        recognizing > 0 ? null : (
          <p className="wf-captions-note" role="status">
            暂无字幕，请点击「{RECOGNIZE_LABEL}」或「{ADD_LABEL}」
          </p>
        )
      ) : (
        <ol aria-label="字幕" className="wf-caption-list">
          {captionsInOrder(captions).map((caption) => (
            <CaptionRow
              caption={caption}
              current={selected.has(caption.id)}
              focus={caption.id === focusing}
              key={caption.id}
              locale={locale}
              onFocused={onFocused}
              onRemove={() => onRemove(caption.id)}
              onSeek={() => onPick(caption)}
              onText={onText}
            />
          ))}
        </ol>
      )}
    </>
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
}

/** 一句字幕：起止时间、删除钮和文字框。 */
function CaptionRow({
  caption,
  locale,
  current,
  focus,
  onFocused,
  onText,
  onRemove,
  onSeek,
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
      className={cn('wf-caption', current && 'is-current')}
    >
      <div className="wf-caption-head">
        <button className="wf-caption-time" onClick={onSeek} type="button">
          {range}
        </button>
        <IconButton label={`删除 ${range} 的字幕`} name="delete" onClick={onRemove} size="xs" />
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
