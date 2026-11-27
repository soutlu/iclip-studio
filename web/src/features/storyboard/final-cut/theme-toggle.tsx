import { Icon } from '@/shared/icons'
import { setThemePreference, useDarkTheme } from '@/shared/lib/theme'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

/**
 * 工作台顶栏上 final-cut 的外观切换：显示着深色时是太阳、点了换浅色，否则是月亮、点了换深色。
 * 选了就不再跟随系统（和用户菜单里选浅色、深色一样）。
 */
export function ThemeToggle() {
  const dark = useDarkTheme()
  const label = dark ? '切换为浅色' : '切换为深色'
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="wf-theme-toggle ui-state ui-focus"
          onClick={() => setThemePreference(dark ? 'light' : 'dark')}
          type="button"
        >
          <Icon decorative name={dark ? 'theme-light' : 'theme-dark'} size="md" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </TooltipRoot>
  )
}
