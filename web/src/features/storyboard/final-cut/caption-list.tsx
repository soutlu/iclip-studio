import { Fragment, useEffect, useId, useRef, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { Audition } from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { ADD_LABEL, RECOGNIZE_LABEL } from './caption-head-buttons'
import { captionClock, captionsInOrder } from './caption-edit'
import type { ScriptNote } from './caption-script'
import type { CaptionsTabProps, CaptionTextChange } from './captions-tab'
import { ownsStyle } from './composition/captions'
import type { CaptionClip } from './composition/film'
import { dubAuditionId } from './dub-audition'
import { EmptyNote } from './empty-note'
import { LineTools, type LineVoiceProps } from './line-voice'
import { RowProgress } from './media-row'
import { captionIn, SOURCE_LOCALE, SOURCE_NAME, type ShownLocale } from './locales'
import { usePausedCommit } from './use-paused-commit'
import { speedText, speedTip } from './voice-lines'

const OWN_STYLE_LABEL = '已单独设置样式'

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
export function CaptionsView({
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
