import { Icon, type IconName } from '@/shared/icons'
import type { Tone } from '../file-kind'
import '../workspace-files.css'

/** 文件页的双色图标：描边和淡填充都按色调上色。 */
export function ToneIcon({ name, tone }: { name: IconName; tone: Tone }) {
  return (
    <span className="files-tone inline-grid shrink-0 place-items-center" data-tone={tone}>
      <Icon decorative name={name} size="sm" />
    </span>
  )
}
