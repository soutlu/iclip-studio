import {
  isDetachedAudio,
  isDubClip,
  type AudioClip,
  type FilmClip,
  type MediaClip,
  type VideoClip,
} from './composition/film'

/**
 * 声音角色：人声、配乐、音效。角色就是声音组（`@hyperframes/core/audio-groups`）：片段上写
 * `data-audio-group="voice"` 这样的组名，引擎按组把这些片段混在一起（组没有自己的效果和音量时声音不变）。
 * 自动压低按组找人声（见 `carve.ts`），所以改角色就是换组，压低的名单跟着变。
 *
 * 没写组（或写的不是这三个组）的片段按声音从哪来算：普通的音频片段是配乐，视频片段、分离出来的原声、
 * 配音片段是人声。
 */
export type AudioRole = 'voice' | 'music' | 'sfx'

export const AUDIO_ROLES: readonly { role: AudioRole; label: string; description: string }[] = [
  { role: 'voice', label: '人声', description: '口播、镜头原声，配乐遇到它会自动压低' },
  { role: 'music', label: '配乐', description: '背景音乐，遇到人声可以自动压低' },
  { role: 'sfx', label: '音效', description: '环境声和转场音效，不会让配乐压低' },
]

export const isAudioRole = (value: string | null): value is AudioRole =>
  value === 'voice' || value === 'music' || value === 'sfx'

/** 人声组的组名：自动压低的名单写这个组。 */
export const VOICE_GROUP: AudioRole = 'voice'

/** 有声音的片段：音频片段，和没关原声的视频片段。 */
export const hasSound = (clip: FilmClip): clip is AudioClip | VideoClip =>
  clip.kind === 'audio' || (clip.kind === 'video' && !clip.muted)

/** 片段的声音角色：写了角色组的照它，没写的按声音从哪来算。 */
export function roleOf(clip: MediaClip): AudioRole {
  if (isAudioRole(clip.audioGroup)) return clip.audioGroup
  return clip.kind === 'audio' && !isDubClip(clip) && !isDetachedAudio(clip) ? 'music' : 'voice'
}
