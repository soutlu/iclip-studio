import { canCarve, carveOf } from './carve'
import { isDubClip, type FilmClip } from './composition/film'
import type { SoundBadge } from './sound-pair'

/**
 * 静音（隐藏）音频片段的角标：配乐行显示「已静音」，配音显示「静音」（分离原声由 `soundBadgeOf` 负责）；静音片段仅展示此角标。
 */
export const mutedBadgeOf = (clip: FilmClip): SoundBadge | undefined =>
  clip.kind === 'audio' && clip.hidden
    ? { text: isDubClip(clip) ? '静音' : '已静音', tone: 'muted' }
    : undefined

/** 自动避让开启态角标：音频片段顶行画成压低图标加「自动避让」，视频片段上只画图标（文字写进无障碍名称）。 */
export const CARVE_BADGE: SoundBadge = { text: '自动避让', tone: 'linked' }

/** 开启自动避让的有声片段角标；静音（隐藏）片段不出声，不展示。 */
export const carveBadgeOf = (clip: FilmClip): SoundBadge | undefined =>
  canCarve(clip) && !clip.hidden && carveOf(clip)?.enabled === true ? CARVE_BADGE : undefined
