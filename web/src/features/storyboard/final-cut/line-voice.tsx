import type { ReactNode } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { BlockedReason } from '../components/blocked-reason'
import { voiceTitleOf, type VoiceControl } from './voice-choices'
import type { LineState } from './voice-lines'

const UNVOICED_NAME = '不配音'

/** 一句的配音按钮要用的：这句的样子、当前语言的人声设置、试听和选音浮层。 */
export type LineVoiceProps = {
  /** 这句在当前语言下的样子。 */
  state: LineState
  voice: VoiceControl
  library: readonly ReferenceAudio[] | undefined
  /** 这句在当前语言下有没有配音片段（有才能试听）。 */
  hasDub: boolean
  /** 这句的配音是不是正在放。 */
  auditioning: boolean
  onAudition: () => void
  /** 选音浮层正给这句选：音色按钮保持展开的样子，按意图显露的一组不收起。 */
  picking: boolean
  /** 给这句打开选音浮层，贴着 `anchor` 弹。 */
  onPickVoice: (anchor: HTMLElement) => void
}

type LineToolsProps = {
  caption: string
  /** 配音按钮要用的；保留原声的句子（外语原声下全部、原文原声下属于视频片段的）是 undefined，没有任何配音按钮。 */
  dub: LineVoiceProps | undefined
  /** 排在最后、按意图显露的「删除」。 */
  remove: ReactNode
}

/**
 * 一句字幕行右上的按钮，从左到右：
 * - 按意图显露（`.wf-reveal`）：有配音片段时「试听」，已配好时「重配」；
 * - 常驻：合成中的小转圈；过期的琥珀色「重配」、要配还没配的琥珀色「配音」（点了只合成这一句）；
 * - 音色：自己选过时常驻写着音色（「Klaus ⌄」「原片音色 ⌄」「不配音 ⌄」），没选过时按意图显露「音色 ⌄」，点了弹选音浮层；
 * - 按意图显露的「删除」。
 * 隐藏的按钮照样占位，常驻的几个排在右边、只隔着「删除」那一格。
 */
export function LineTools({ caption, dub, remove }: LineToolsProps) {
  if (dub === undefined || dub.state.status === 'original')
    return (
      <span className="wf-line-tools">
        <span className="wf-reveal wf-line-reveal">{remove}</span>
      </span>
    )
  const { state, voice, library, hasDub, auditioning, onAudition, picking, onPickVoice } = dub
  const { own } = state
  // 整种语言一句都还没配过时，「生成配音」在页签顶上，各句不再一一提醒
  const remind =
    state.status === 'stale' ||
    (state.status === 'missing' && (voice.mode === 'original' || voice.summary.dubbed))
  const ownName =
    own === undefined ? undefined : 'dub' in own ? UNVOICED_NAME : voiceTitleOf(own.voice, library)
  const voiceButton = (
    <button
      aria-label={ownName === undefined ? '本句音色：跟随默认' : `本句音色：${ownName}`}
      className={cn(
        'wf-chip-btn wf-line-chip ui-state ui-focus',
        ownName === undefined ? 'wf-reveal' : 'is-tonal',
      )}
      data-state={picking ? 'open' : undefined}
      onClick={(event) => onPickVoice(event.currentTarget)}
      type="button"
    >
      <span className="wf-line-chip-name">{ownName ?? '音色'}</span>
      <Icon decorative name="final-cut-expand" size="xs" />
    </button>
  )
  return (
    <span className="wf-line-tools">
      <span className="wf-reveal wf-line-reveal">
        {hasDub ? (
          <IconButton
            label={auditioning ? '暂停本句配音试听' : '试听本句配音'}
            name={auditioning ? 'final-cut-pause' : 'final-cut-sound-on'}
            onClick={onAudition}
            size="xs"
            tooltip={auditioning ? '暂停本句配音试听' : '试听本句配音'}
          />
        ) : null}
        {state.status === 'ready' ? (
          <BlockedReason reason={state.blocked}>
            <IconButton
              aria-disabled={state.blocked === undefined ? undefined : true}
              label="重配本句"
              name="final-cut-reset"
              onClick={() => voice.dubLine(caption)}
              size="xs"
            />
          </BlockedReason>
        ) : null}
      </span>
      {state.status === 'running' ? (
        <span aria-label="本句配音合成中" className="wf-line-busy" role="img">
          <Icon className="animate-spin" decorative name="spinner" size="xs" />
        </span>
      ) : remind ? (
        <BlockedReason reason={state.blocked}>
          <button
            aria-disabled={state.blocked === undefined ? undefined : true}
            className="wf-chip-btn is-warning ui-state ui-focus"
            onClick={() => voice.dubLine(caption)}
            type="button"
          >
            <Icon decorative name="final-cut-reset" size="xs" />
            {state.status === 'stale' ? '重配' : '配音'}
          </button>
        </BlockedReason>
      ) : null}
      {/* 音色按钮一直排在这一格（自己选过时常驻、没选过时按意图显露）：选完音色它还是同一个元素，浮层收起时焦点回得去 */}
      {voiceButton}
      <span className="wf-reveal wf-line-reveal">{remove}</span>
    </span>
  )
}
