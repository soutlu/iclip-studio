import type { RefObject } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { AudioCover } from '@/shared/ui/audition'
import type { PeaksState } from '../editing/media-analysis'
import { Frames, Wave } from '../editing/timeline'
import type { Timing } from './clip-edit'
import { CARVE_BADGE } from './clip-badges'
import type { FilmClip } from './composition/film'
import type { DubLook } from './dub-look'
import type { SoundBadge } from './sound-pair'

/** 当前语言下没字（没翻、空着）的字幕片段上写的字。 */
export const BLANK_CAPTION = '待输入字幕'

/**
 * 片段状态角标：分离原声、静音以文字标签呈现；自动避让在音频片段顶行是压低图标加文字，在视频片段上只有图标
 * （`iconOnly`）。
 */
function ClipBadge({ badge, iconOnly = false }: { badge: SoundBadge; iconOnly?: boolean }) {
  if (badge !== CARVE_BADGE)
    return (
      <span aria-hidden="true" className="wf-clip-badge" data-tone={badge.tone}>
        {badge.text}
      </span>
    )
  return iconOnly ? (
    <Icon className="wf-clip-duck" decorative name="final-cut-duck" size="xs" />
  ) : (
    <span aria-hidden="true" className="wf-clip-badge" data-tone={badge.tone}>
      <Icon decorative name="final-cut-duck" size="xs" />
      {badge.text}
    </span>
  )
}

/**
 * 渲染时间线片段主体内容：画面类片段不叠加文字（视频平铺抽帧且未分离原声时底部叠加细原声波形；元素与模板片段平铺封面帧条，名称与文本由悬停提示展示）；
 * 字幕渲染为写着正文的胶囊（当前语言下没字时写「待输入字幕」）；音频顶行写名字（配音片段是音色的小图标、音色名和
 * 加速倍数）和状态角标，下面是贴底波形；「其他」片段仅展示名称。
 */
export function ClipContent({
  clip,
  timing,
  cover,
  badge,
  blank,
  dub,
  keyframes,
  withSound,
  peaks,
  wave,
  waveRef,
}: {
  clip: FilmClip
  timing: Timing
  cover: string | null
  badge: SoundBadge | undefined
  /** 字幕片段在当前语言下没字。 */
  blank: boolean
  /** 配音片段顶行的样子；别的片段是 undefined。 */
  dub: DubLook | undefined
  /** 是否存在音量关键帧：音频片段在标题条内标注（视频片段直接通过包络曲线体现）。 */
  keyframes: boolean
  /** 视频片段是否仍保留原声（未分离）：为真时底部叠加原声波形。 */
  withSound: boolean
  peaks: PeaksState
  /** 有声片段波形绘制参数：相对增益、是否静音置灰及是否含音量包络。 */
  wave: ClipWave
  /** 波形容器引用，供音量包络层对齐叠加。 */
  waveRef: RefObject<HTMLSpanElement | null>
}) {
  const name = <span className="wf-clip-name">{clip.label}</span>
  if (clip.kind === 'other') return name
  if (clip.kind === 'caption')
    return blank ? <span className="wf-clip-name is-blank">{BLANK_CAPTION}</span> : name
  if (clip.kind === 'host')
    return cover === null ? null : (
      // 片段宽度随缩放动态变化，使用 background-repeat 横向平铺封面图避免手动计算张数
      <span className="wf-clip-strip" style={{ backgroundImage: `url("${cover}")` }} />
    )
  // 片段展示对应的素材区间：轨道时长 × 播放倍速
  const part = {
    mediaUrl: clip.src,
    start: timing.mediaStart / 1000,
    end: (timing.mediaStart + timing.duration * clip.playbackRate) / 1000,
  }
  const waveClass = cn(wave.silent && 'is-silent', wave.envelope && 'has-envelope')
  if (clip.kind === 'audio')
    return (
      <>
        <span className="wf-clip-label">
          {dub === undefined ? (
            name
          ) : (
            <>
              {dub.cover === undefined ? (
                <Icon className="wf-clip-voice" decorative name="final-cut-voice" size="xs" />
              ) : (
                <AudioCover {...dub.cover} size="2xs" state="idle" title={dub.voice} />
              )}
              <span className="wf-clip-name">{dub.voice}</span>
              {dub.speed === undefined ? null : (
                <span
                  aria-hidden="true"
                  className="wf-clip-badge"
                  data-tone={dub.trimmed ? 'offset' : 'muted'}
                >
                  {dub.speed}
                </span>
              )}
            </>
          )}
          {badge === undefined ? null : <ClipBadge badge={badge} />}
          {keyframes ? (
            <span aria-hidden="true" className="wf-clip-badge wf-clip-keyframes">
              关键帧
            </span>
          ) : null}
        </span>
        <span className={cn('wf-clip-sound', waveClass)} ref={waveRef}>
          <Wave bars="bottom" level={wave.level} part={part} state={peaks} />
        </span>
      </>
    )
  // 底部原声波形条仅 7px 高，容不下状态提示文案，仅在波形数据就绪后叠加展示
  return (
    <>
      <span className="wf-clip-frames">
        <Frames part={part} />
      </span>
      {withSound && peaks.kind === 'ready' ? (
        <span className={cn('wf-clip-wave', waveClass)} ref={waveRef}>
          <Wave bars="bottom" level={wave.level} part={part} state={peaks} />
        </span>
      ) : null}
      {badge === undefined ? null : <ClipBadge badge={badge} iconOnly />}
    </>
  )
}

export type ClipWave = {
  level: (fraction: number) => number
  silent: boolean
  envelope: boolean
}
