import type { IconName } from '@/shared/icons'

const PLUGIN_ICONS: Record<string, IconName> = {
  iclip_studio: 'layers',
  shot_video: 'video-type',
  video: 'video-understanding',
  video_breakdown: 'film',
  video_shots: 'shot-list',
  workspace: 'folder',
}

export const pluginIcon = (name: string): IconName => PLUGIN_ICONS[name] ?? 'plugin'
