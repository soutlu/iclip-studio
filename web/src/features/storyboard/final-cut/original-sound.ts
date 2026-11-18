import type { ClipAttribute, VideoClip } from './composition/film'

/** 片段上要改的几个属性：null 是去掉。 */
export type AttributeChanges = Readonly<Partial<Record<ClipAttribute, string | null>>>

/**
 * 视频片段「关闭原声」（`off` 为真）或打开原声要改的属性。照参照的工作台：关闭写 muted、去掉有声音的标记，
 * 打开反过来，两个不同时写。
 */
export const originalSoundChanges = (off: boolean): AttributeChanges =>
  off ? { muted: 'true', 'data-has-audio': null } : { muted: null, 'data-has-audio': 'true' }

/**
 * 这个视频片段为什么不能打开原声；能打开时是 undefined。素材确认没有声音（`silent`）时不让打开：
 * 标成有声音的视频片段导出必定失败。
 */
export const originalSoundBlocked = (clip: VideoClip, silent: boolean): string | undefined =>
  silent && clip.muted ? '该素材没有声音，无法打开原声' : undefined
