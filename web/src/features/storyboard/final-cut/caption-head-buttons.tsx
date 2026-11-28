import { useRef, useState, type ReactElement, type RefObject } from 'react'
import { Icon } from '@/shared/icons'
import { AudioCover } from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from '../components/blocked-reason'
import { voiceCoverOf, voiceTitleOf, type VoiceControl, type VoiceLibrary } from './voice-choices'

export const ADD_LABEL = '在播放头处添加字幕'
export const RECOGNIZE_LABEL = '识别'
const TRANSLATE_LABEL = '翻译'

/**
 * 第二排按钮的悬停提示，同一时间只说一件事：有 `note`（识别结果）时说它，不能用时说原因（悬停或点击，同
 * `BlockedReason`），按钮的字被收起、只剩图标时（第二排放不下，见 `caption-voice.css` 的让步）写按钮名 `name`。
 * 字收没收起看 `wordRef` 这段字此刻有没有显示，阈值只在样式里定。`note` 收起时调用 `onNoteClose`。
 */
function FoldTip({
  name,
  wordRef,
  blocked,
  note,
  onNoteClose,
  children,
}: {
  name: string
  wordRef: RefObject<HTMLElement | null>
  blocked: string | undefined
  note?: string | undefined
  onNoteClose?: () => void
  children: ReactElement
}) {
  const [hint, setHint] = useState(false)
  const [folded, setFolded] = useState(false)
  const shown = note ?? (hint ? (blocked ?? (folded ? name : undefined)) : undefined)
  return (
    <TooltipRoot
      onOpenChange={(open) => {
        const word = wordRef.current
        setHint(open)
        setFolded(open && word !== null && getComputedStyle(word).display === 'none')
        if (!open && note !== undefined) onNoteClose?.()
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
        {children}
      </TooltipTrigger>
      {shown === undefined ? null : (
        <TooltipContent className="wf-tip" side="top">
          {shown}
        </TooltipContent>
      )}
    </TooltipRoot>
  )
}

/** 译文语言下的「翻译」控制：包含禁用原因与翻译进行中状态。 */
export type TranslateControl = {
  blocked: string | undefined
  translating: boolean
  onTranslate: () => void
}

/** 配音时第二排的默认音色胶囊：小封面、名字（放不下时截断）和 ⌄，点了弹选音浮层。 */
export function DefaultVoice({
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
 * 「重配 N 句」（只合成它们）；全部最新时收成一个「重新生成」图标按钮。第二排放不下时最后才只留图标和数字（读屏名不变，
 * 悬停提示写着名字，见 `FoldTip`）。
 */
export function DubButton({ voice }: { voice: VoiceControl }) {
  const wordRef = useRef<HTMLSpanElement | null>(null)
  const { summary, generate, fill } = voice
  if (summary.running > 0) {
    const name = `正在生成配音，还剩 ${summary.running} 句`
    return (
      <FoldTip blocked={undefined} name={name} wordRef={wordRef}>
        <span aria-label={name} className="wf-chip-btn is-soft wf-dub-main" role="status">
          <Icon className="animate-spin" decorative name="spinner" size="sm" />
          <span className="wf-dub-word" ref={wordRef}>
            还剩{' '}
          </span>
          {summary.running}
          <span className="wf-dub-word"> 句</span>
        </span>
      </FoldTip>
    )
  }
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
  const name = first ? '生成配音' : `重配 ${summary.pending} 句`
  return (
    <FoldTip blocked={action.blocked} name={name} wordRef={wordRef}>
      <button
        aria-disabled={action.blocked === undefined ? undefined : true}
        aria-label={name}
        className="wf-chip-btn is-soft wf-dub-main ui-state ui-focus"
        onClick={action.run}
        type="button"
      >
        <Icon decorative name={first ? 'final-cut-generate' : 'final-cut-reset'} size="sm" />
        {first ? (
          <span className="wf-dub-word" ref={wordRef}>
            生成配音
          </span>
        ) : (
          <>
            <span className="wf-dub-word" ref={wordRef}>
              重配{' '}
            </span>
            {summary.pending}
            <span className="wf-dub-word"> 句</span>
          </>
        )}
      </button>
    </FoldTip>
  )
}

/** 「翻译」按钮：第二排放不下时先收起字、只留图标（读屏名不变，悬停写着名字，见 `FoldTip`）。 */
export function TranslateButton({ translate }: { translate: TranslateControl }) {
  const wordRef = useRef<HTMLSpanElement | null>(null)
  const label = translate.translating ? '翻译中…' : TRANSLATE_LABEL
  return (
    <FoldTip blocked={translate.blocked} name={label} wordRef={wordRef}>
      <button
        aria-disabled={translate.blocked === undefined ? undefined : true}
        aria-label={label}
        className="wf-chip-btn is-tonal ui-state ui-focus"
        onClick={() => {
          if (translate.blocked === undefined) translate.onTranslate()
        }}
        type="button"
      >
        <Icon decorative name="final-cut-translate" size="sm" />
        <span className="wf-captions-word" ref={wordRef}>
          {label}
        </span>
      </button>
    </FoldTip>
  )
}

/**
 * 第二排最右侧的「+」按钮：在播放头处新增一句字幕。悬停展示功能名；不可用时置灰并在悬停及点击时说明原因
 * （交互行为与工具条禁用按钮一致，见 `editor-toolbar.tsx` 的 `Tool`）。
 */
export function AddLineButton({
  blocked,
  onAdd,
}: {
  blocked: string | undefined
  onAdd: () => void
}) {
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
 * 鼠标移开、按 Esc 或再点按钮时收起并调用 `onNoteClose`。第二排放不下时先收起字、只留图标（读屏名不变，悬停写着名字，
 * 见 `FoldTip`）。
 */
export function RecognizeButton({
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
  const wordRef = useRef<HTMLSpanElement | null>(null)
  const label = recognizing > 0 ? '识别中…' : RECOGNIZE_LABEL
  return (
    <FoldTip blocked={blocked} name={label} note={note} onNoteClose={onNoteClose} wordRef={wordRef}>
      <button
        aria-disabled={blocked === undefined ? undefined : true}
        aria-label={label}
        className="wf-chip-btn is-tonal ui-state ui-focus"
        onClick={() => {
          if (blocked === undefined) onRecognize()
        }}
        type="button"
      >
        <Icon decorative name="final-cut-voice" size="sm" />
        <span className="wf-captions-word" ref={wordRef}>
          {label}
        </span>
      </button>
    </FoldTip>
  )
}
