import { useState } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from '../components/blocked-reason'
import type { LineVoice } from './composition/voices'
import { ORIGINAL_VOICE_NAME, ownLineVoice, voiceNameOf, type VoiceControl } from './voice-choices'

const FOLLOW = 'follow'
const ORIGINAL = 'original'
const UNVOICED = 'unvoiced'
const UNVOICED_NAME = '不配音'

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

type LineVoiceChipProps = {
  caption: string
  voice: VoiceControl
  library: readonly ReferenceAudio[] | undefined
  /** 常用音色的编号（见 `commonVoices`）。 */
  common: readonly string[]
  /** 菜单最后的「更多音色…」：给这一句打开选音面板。 */
  onMore: () => void
}

/**
 * 译文语言下单句字幕右上的配音标签：保留原声时是只读的「原声」；AI 配音时跟随整体的写「跟随 · 音色名」（灰），
 * 单独设过的写「单句 · 音色名」或「单句 · 不配音」。点开是单选菜单：跟随整体音色、原声、常用音色（再加这句自己选的那个）、
 * 不配音，最后「更多音色…」；选了只记下，不合成。这句不能选音色时置灰并说明原因。
 */
export function LineVoiceChip({ caption, voice, library, common, onMore }: LineVoiceChipProps) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  if (voice.mode === 'original') return <span className="wf-line-voice">{ORIGINAL_VOICE_NAME}</span>
  const own = ownLineVoice(voice, caption)
  const chosen = own ?? { voice: voice.voice }
  const name =
    'dub' in chosen
      ? UNVOICED_NAME
      : chosen.voice === null
        ? ORIGINAL_VOICE_NAME
        : voiceNameOf(chosen.voice, library)
  const label = `本句配音：${name}${own === undefined ? '，跟随整体音色' : ''}`
  const blocked = voice.lines.get(caption)?.chooseBlocked
  const chip = (
    <button
      aria-disabled={blocked === undefined ? undefined : true}
      aria-label={label}
      className={cn('wf-line-voice is-voiced ui-state ui-focus', own !== undefined && 'is-own')}
      type="button"
    >
      <span className="wf-line-voice-name">{`${own === undefined ? '跟随' : '单句'} · ${name}`}</span>
      <Icon decorative name="final-cut-expand" size="xs" />
    </button>
  )
  if (blocked !== undefined) return <BlockedReason reason={blocked}>{chip}</BlockedReason>
  const picked = valueOfLineVoice(own)
  const ownVoice = own !== undefined && 'voice' in own ? own.voice : null
  const listed = ownVoice === null || common.includes(ownVoice) ? common : [...common, ownVoice]
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
          <MenuRadioItem value={ORIGINAL}>{ORIGINAL_VOICE_NAME}</MenuRadioItem>
          {listed.map((id) => (
            <MenuRadioItem key={id} value={`voice:${id}`}>
              {voiceNameOf(id, library)}
            </MenuRadioItem>
          ))}
          <MenuRadioItem value={UNVOICED}>{UNVOICED_NAME}</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={onMore}>更多音色…</MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}
