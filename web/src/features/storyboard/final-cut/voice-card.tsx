import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { AudioCover, AuditionBuffering, voiceTraitsText, type Audition } from '@/shared/ui/audition'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { BlockedReason } from '../components/blocked-reason'
import { AudioCardText } from './audio-card'
import {
  languageChoice,
  ORIGINAL_VOICE_NAME,
  voiceBusy,
  voiceLocaleTag,
  voiceNameOf,
  type VoiceControl,
  type VoiceLibrary,
} from './voice-choices'

type CurrentVoiceProps = {
  /** 用着的音色编号；null 是原声。 */
  id: string | null
  library: readonly ReferenceAudio[] | undefined
  /** 保留原声时整体音色不出声：这一行灰一点，照样能换。 */
  muted?: boolean
  audition: Audition
  onToggle: (audio: ReferenceAudio) => void
  /** 点「更换」：打开选音面板。 */
  onChange: () => void
}

/**
 * 当前音色行：封面（点了试听）、名字和语种小字、下面一行属性，右边「更换 ›」。原声没有封面，是一个中性的圆形图标块；
 * 资料库里查不到的音色（被移除或还没读到）用兜底名、不能试听。人声卡和旁白面板共用。
 */
export function CurrentVoice({
  id,
  library,
  muted = false,
  audition,
  onToggle,
  onChange,
}: CurrentVoiceProps) {
  const audio = id === null ? undefined : library?.find((each) => each.id === id)
  const name = id === null ? ORIGINAL_VOICE_NAME : voiceNameOf(id, library)
  const current = audio !== undefined && audition.current === audio.id
  const playing = audio !== undefined && audition.playing === audio.id
  return (
    <div className={cn('wf-voice-current', muted && 'is-muted')}>
      {id === null ? (
        <span aria-hidden className="wf-voice-original">
          <Icon decorative name="final-cut-voice" size="sm" />
        </span>
      ) : (
        <AudioCover
          id={id}
          onToggle={audio === undefined ? undefined : () => onToggle(audio)}
          size="sm"
          state={playing ? 'playing' : current ? 'paused' : 'idle'}
          title={name}
          traits={audio}
        >
          {current ? <AuditionBuffering audition={audition} /> : null}
        </AudioCover>
      )}
      <AudioCardText
        meta={audio === undefined ? undefined : voiceLocaleTag(audio.locale)}
        title={name}
        traits={audio === undefined ? undefined : (voiceTraitsText(audio) ?? undefined)}
      />
      <button
        aria-label="更换音色"
        className="wf-voice-change ui-state ui-focus"
        onClick={onChange}
        type="button"
      >
        更换
        <Icon decorative name="final-cut-disclosure" size="xs" />
      </button>
    </div>
  )
}

type VoiceCardProps = {
  voice: VoiceControl
  library: VoiceLibrary
  /** 常用音色的编号（见 `commonVoices`），排在「原声」后面。 */
  common: readonly string[]
  audition: Audition
  onToggle: (audio: ReferenceAudio) => void
  /** 点当前音色行的「更换」：给整体音色打开选音面板。 */
  onChange: () => void
}

/**
 * 译文语言下的人声卡：顶栏「人声」、「保留原声」及已有配音时的「重新生成」；下面当前音色行（见 `CurrentVoice`）和
 * 一排常用音色（「原声」居首）。点常用音色：这种语言已有它的配音时直接切回 AI 配音，否则设成整体音色并重配跟着它的句子。
 */
export function VoiceCard({
  voice,
  library,
  common,
  audition,
  onToggle,
  onChange,
}: VoiceCardProps) {
  const { mode, dubbed, generating, narrating, onMode, onRedo } = voice
  const redoBlocked = voiceBusy(voice) ?? voice.redoBlocked
  const chips = [
    { value: 'original', name: ORIGINAL_VOICE_NAME, ...languageChoice(voice, null) },
    ...common.map((id) => ({
      value: `voice:${id}`,
      name: voiceNameOf(id, library.voices),
      ...languageChoice(voice, id),
    })),
  ]
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
      <CurrentVoice
        audition={audition}
        id={voice.voice}
        library={library.voices}
        muted={mode === 'original'}
        onChange={onChange}
        onToggle={onToggle}
      />
      <ChipGroup
        aria-label="常用音色"
        className="wf-voice-common"
        onValueChange={(value) => chips.find((chip) => chip.value === value)?.pick()}
        type="single"
        value={chips.find((chip) => chip.picked)?.value ?? ''}
        variant="option"
      >
        {chips.map((chip) => (
          // 选项小块自己带 data-state（选中与否），提示挂在外面一层上，不去盖掉它
          <BlockedReason key={chip.value} reason={chip.blocked}>
            <span className="wf-voice-common-item">
              <FilterChip
                aria-disabled={chip.blocked === undefined ? undefined : true}
                title={chip.name}
                value={chip.value}
                variant="option"
              >
                {chip.name}
              </FilterChip>
            </span>
          </BlockedReason>
        ))}
      </ChipGroup>
      {library.problem === undefined ? null : (
        <InlineAlert
          action={{ label: '重试', onClick: library.problem.onRetry }}
          message={library.problem.message}
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
