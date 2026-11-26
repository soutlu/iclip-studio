import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { audioClockText, useAuditionRatio, Waveform, type Audition } from '@/shared/ui/audition'

// 只有正在放（或暂停着）的那一行挂这几块：它们订阅每帧的进度，整张表不跟着重画

type RowProgressProps = { audio: ReferenceAudio; audition: Audition }

/** 时长那格：放着时换成当前播放到的时刻。 */
export function RowClock({ audio, audition }: RowProgressProps) {
  const { timeMs } = useAuditionRatio(audition, audio.durationMs)
  return audioClockText(timeMs)
}

/** 配乐、音效的波形列：当前这条按进度上色，别的整条淡色。 */
export function RowWaveform({ audio, audition, current }: RowProgressProps & { current: boolean }) {
  return current ? (
    <CurrentWaveform audio={audio} audition={audition} />
  ) : (
    <Waveform peaks={audio.peaks} />
  )
}

function CurrentWaveform({ audio, audition }: RowProgressProps) {
  const { ratio } = useAuditionRatio(audition, audio.durationMs)
  return <Waveform peaks={audio.peaks} progress={ratio} />
}
