import type { IconName } from '@/shared/icons'

export function skillIcon(name: string | undefined): IconName {
  switch (name ?? '') {
    case 'director':
      return 'resource-reference-video'
    case 'storyboard-workflow':
      return 'resource-storyboard'
    case 'viral-script-remix':
      return 'resource-script-breakdown'
    default:
      return 'skill'
  }
}
