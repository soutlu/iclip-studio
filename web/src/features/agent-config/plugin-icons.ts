import type { IconName } from '@/shared/icons'

// 插件登记表随代码发布（CONTEXT「插件」），接口不给图标；认得的插件配专属图标，新插件用通用图标。
const PLUGIN_ICONS: Record<string, IconName> = {
  iclip_studio: 'layers',
  shot_video: 'video-type',
  video: 'video-understanding',
  video_breakdown: 'film',
  video_shots: 'shot-list',
  workspace: 'folder',
}

export const pluginIcon = (name: string): IconName => PLUGIN_ICONS[name] ?? 'plugin'
