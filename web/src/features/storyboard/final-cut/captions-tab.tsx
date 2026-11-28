import { useEffect, useId, useState, type ComponentProps, type Ref } from 'react'
import type { Audition } from '@/shared/ui/audition'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import {
  AddLineButton,
  DefaultVoice,
  DubButton,
  RecognizeButton,
  TranslateButton,
  type TranslateControl,
} from './caption-head-buttons'
import { CaptionsView } from './caption-list'
// 视图的取值和 `CaptionsView` 组件同名：取值换个名字引入
import type { CaptionsView as CaptionsViewKind } from './caption-edit'
import type { ScriptNote } from './caption-script'
import { ComponentTexts } from './component-texts'
import type { AudioClip, CaptionClip } from './composition/film'
import { DUB_AUDITION, dubAuditionId } from './dub-audition'
import { LocaleBar, type LocaleControls } from './editor-toolbar'
import {
  captionIn,
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  type Language,
  type ShownLocale,
} from './locales'
import { usePausedCommit } from './use-paused-commit'
import type { VoiceControl, VoiceLibrary } from './voice-choices'
import type { VoicePickTarget } from './voice-picker'

/** 修改指定字幕在目标语言 `locale` 下的文本（见 `useFilmSession` 的 `setCaptionText`）。 */
export type CaptionTextChange = (id: string, text: string, locale: Language) => void

export type CaptionsTabProps = {
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
  focus: { lines: ReadonlySet<string>; view: CaptionsViewKind | undefined }
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
  const [view, setView] = useState<CaptionsViewKind>(focus.view ?? 'captions')
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
