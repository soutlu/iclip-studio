import { Icon, type IconName } from '@/shared/icons'
import type { Tone } from '../file-kind'
import '../workspace-files.css'

/** 文件页双色图标包装器：描边与浅填充层统一按指定色调着色。 */
export function ToneIcon({ name, tone }: { name: IconName; tone: Tone }) {
  return (
    <span className="files-tone inline-grid shrink-0 place-items-center" data-tone={tone}>
      <Icon decorative name={name} size="sm" />
    </span>
  )
}
