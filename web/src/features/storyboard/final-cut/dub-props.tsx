import { useId } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { AudioCover } from '@/shared/ui/audition'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from '../components/blocked-reason'
import type { AudioClip, AudioDub } from './composition/film'
import { Tool } from './editor-toolbar'
import { PropRow } from './ui/prop-layout'
import { ORIGINAL_VOICE_NAME, voiceNameOf, type VoiceControl } from './voice-choices'
import { speedText, speedTip, type LineState } from './voice-lines'

type DubClip = AudioClip & { dub: AudioDub }

/** 点配音片段「音色」那一行：`caption` 是它配的那句字幕，`trigger` 是这一行的按钮（浮层就近弹出、收起时焦点回到它）。 */
export type PickDubVoice = (caption: string, trigger: HTMLElement) => void

/**
 * 一段配音在「属性」里怎么显示：`line` 是它那句在显示着的语言下的样子（见 `LineState`）；它不是这种语言的配音
 * （外语原声时照样放的原文旁白）时没有，音色、倍数照片段合成时记下的，也不能在这里改音色、重新合成。
 */
type DubView = {
  line: LineState | undefined
  /** 生效的音色：资料库音色编号，null 是原片音色。 */
  voice: string | null
  speed: number
  trimmed: boolean
}

/** 配音片段 `clip` 的样子（见 `DubView`），规则和时间线上的配音片段一样（见 `dubLooksOf`）。 */
function dubViewOf(clip: DubClip, control: VoiceControl | undefined): DubView {
  const { dub } = clip
  const line = control?.locale === dub.locale ? control.lines.get(dub.caption) : undefined
  return {
    line,
    // 设成保留原声、不配音时这句没有要用的音色，显示片段合成时用的
    voice: line?.voice === undefined ? dub.voice : line.voice,
    speed: line?.speed ?? dub.speed,
    trimmed: line?.trimmed ?? dub.trimmed,
  }
}

/**
 * 标题行右边的「重新合成」：只合成这一句（`dubLine`），过期时用提示色突出；不能合成时置灰，悬停说明原因。
 * 不是显示着的语言的配音时没有。
 */
export function RedubTool({ clip, control }: { clip: DubClip; control: VoiceControl | undefined }) {
  const { line } = dubViewOf(clip, control)
  if (control === undefined || line === undefined) return null
  return (
    <Tool
      blocked={line.blocked}
      className={cn(line.status === 'stale' && 'is-warning')}
      icon="final-cut-reset"
      label="重新合成"
      onClick={() => control.dubLine(clip.dub.caption)}
      tip="重新合成"
    />
  )
}

/**
 * 配音片段最上面两行：「音色」是生效音色的小封面、名字和 ⌄，点它交给 `onPick`（没给、不是显示着的语言的配音、这句
 * 不能选音色时不能点）；「槽位倍速」是这段配音为塞进字幕的时长加速的倍数（见 `speedText`，没加速写 1×），截了尾
 * 用提示色，加速了或截了尾时悬停说明原因（见 `speedTip`）。
 */
export function DubRows({
  clip,
  control,
  voices,
  onPick,
}: {
  clip: DubClip
  control: VoiceControl | undefined
  /** 资料库里的音色，找名字和封面用；还没读到时是 undefined。 */
  voices: readonly ReferenceAudio[] | undefined
  onPick: PickDubVoice | undefined
}) {
  const voiceId = useId()
  const view = dubViewOf(clip, control)
  const name = view.voice === null ? ORIGINAL_VOICE_NAME : voiceNameOf(view.voice, voices)
  const traits = voices?.find((each) => each.id === view.voice)
  const blocked = view.line?.chooseBlocked
  const pick = view.line === undefined ? undefined : onPick
  const speed = speedText(view.speed, view.trimmed)
  return (
    <>
      <PropRow htmlFor={voiceId} label="音色">
        <BlockedReason reason={blocked}>
          <button
            aria-disabled={blocked === undefined ? undefined : true}
            aria-label={`音色：${name}`}
            className="wf-field wf-prop-select ui-state ui-focus"
            disabled={pick === undefined}
            id={voiceId}
            onClick={(event) => {
              if (blocked === undefined) pick?.(clip.dub.caption, event.currentTarget)
            }}
            type="button"
          >
            <AudioCover
              art={view.voice === null ? 'original' : undefined}
              id={view.voice ?? 'original'}
              size="xs"
              state="idle"
              title={name}
              traits={traits}
            />
            <span className="wf-prop-select-text">{name}</span>
            <Icon decorative name="final-cut-expand" size="xs" />
          </button>
        </BlockedReason>
      </PropRow>
      <PropRow label="槽位倍速">
        {speed === undefined ? (
          <span className="wf-field is-static">1×</span>
        ) : (
          <TooltipRoot>
            <TooltipTrigger asChild>
              <span className={cn('wf-field is-static', view.trimmed && 'is-warning')}>
                {speed}
              </span>
            </TooltipTrigger>
            <TooltipContent className="wf-tip" side="top">
              {speedTip(speed, view.trimmed)}
            </TooltipContent>
          </TooltipRoot>
        )}
      </PropRow>
    </>
  )
}
