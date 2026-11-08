import { useCallback } from 'react'
import { useLogout, userDisplayName, useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import {
  setThemePreference,
  THEME_PREFERENCES,
  useThemePreference,
  type ThemePreference,
} from '@/shared/lib/theme'
import { cn } from '@/shared/lib/utils'
import {
  MenuIconRadioItem,
  MenuItem,
  MenuRadioGroup,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'

type CueUserMenuAlign = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'

type CueUserMenuProps = {
  align?: CueUserMenuAlign
  className?: string
  compact?: boolean
}

const ALIGN_PLACEMENT: Record<
  CueUserMenuAlign,
  { align: 'start' | 'end'; side: 'bottom' | 'top' }
> = {
  'bottom-end': { align: 'end', side: 'bottom' },
  'bottom-start': { align: 'start', side: 'bottom' },
  'top-end': { align: 'end', side: 'top' },
  'top-start': { align: 'start', side: 'top' },
}

const USER_CARD_BUTTON_CLASS =
  'group flex h-12 w-full ui-state cursor-pointer items-center gap-2.5 rounded-md px-2 text-body text-on-surface select-none focus-visible:bg-inverse-surface focus-visible:text-inverse-on-surface focus-visible:outline-hidden data-[state=open]:bg-state-active'

const APPEARANCE: Record<ThemePreference, { icon: IconName; label: string }> = {
  dark: { icon: 'theme-dark', label: '深色' },
  light: { icon: 'theme-light', label: '浅色' },
  system: { icon: 'theme-system', label: '跟随系统' },
}

const USER_AVATAR_CLASS =
  'grid size-8 shrink-0 place-items-center overflow-hidden rounded-full text-label font-semibold'

export function CueUserMenu({
  align = 'bottom-end',
  className = '',
  compact = false,
}: CueUserMenuProps) {
  const { data: user } = useUser()
  const logoutMutation = useLogout()
  const appearance = useThemePreference()
  const isLoggingOut = logoutMutation.isPending

  const handleLogout = useCallback(() => {
    if (logoutMutation.isPending) {
      return
    }

    logoutMutation.mutate()
  }, [logoutMutation])

  const userLabel = userDisplayName(user)
  const secondaryLabel = user?.username && user.username !== userLabel ? user.username : ''
  const departments = user?.departments ?? []
  const hasProfileDetails = Boolean(user?.jobTitle || user?.city || departments.length)
  const avatarUrl = user?.avatarUrl.trim() ?? ''
  const avatarInitial = user ? userLabel.trim().charAt(0).toUpperCase() : ''

  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label="用户菜单"
          title={userLabel}
          className={cn(
            USER_CARD_BUTTON_CLASS,
            compact && 'mx-auto size-10 justify-center px-0',
            className,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              USER_AVATAR_CLASS,
              avatarUrl
                ? 'border border-border bg-top-layer text-on-surface'
                : 'bg-surface-container-high text-on-surface-variant',
            )}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : avatarInitial ? (
              avatarInitial
            ) : (
              <CueUserAvatarIcon />
            )}
          </span>
          {!compact && (
            <>
              <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col text-left">
                <span className="truncate font-semibold">{userLabel}</span>
                {secondaryLabel ? (
                  <span className="truncate text-label text-on-surface-faint group-focus-visible:text-inherit">
                    {secondaryLabel}
                  </span>
                ) : null}
              </span>
              <Icon
                className="shrink-0 text-on-surface-faint group-focus-visible:text-inherit"
                decorative
                name="dropdown"
                size="md"
              />
            </>
          )}
        </button>
      </MenuTrigger>

      <MenuSurface
        align={ALIGN_PLACEMENT[align].align}
        side={ALIGN_PLACEMENT[align].side}
        className="w-[280px] gap-0 overflow-hidden"
      >
        <div className="border-b border-border px-3 py-2.5">
          <p className="truncate text-body-sm font-semibold text-on-background">{userLabel}</p>
          <p className="mt-0.5 text-caption text-on-surface-variant">当前账号</p>
          {hasProfileDetails ? (
            <dl className="mt-3 grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-t border-border pt-3 text-caption">
              {user?.jobTitle ? (
                <>
                  <dt className="text-on-surface-variant">职位</dt>
                  <dd className="truncate text-on-background" title={user.jobTitle}>
                    {user.jobTitle}
                  </dd>
                </>
              ) : null}
              {user?.city ? (
                <>
                  <dt className="text-on-surface-variant">城市</dt>
                  <dd className="truncate text-on-background" title={user.city}>
                    {user.city}
                  </dd>
                </>
              ) : null}
              {departments.length ? (
                <>
                  <dt className="text-on-surface-variant">部门</dt>
                  <dd className="min-w-0 space-y-1 text-on-background">
                    {departments.map((department) => (
                      <p
                        key={`${department.id}:${department.uid}`}
                        className="truncate"
                        title={department.name}
                      >
                        {department.name}
                      </p>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </div>
        <div className="flex h-(--control-height-sm) items-center gap-2 pr-1 pl-2 text-body text-on-surface">
          <Icon
            className="shrink-0 text-on-surface-variant"
            decorative
            name="appearance"
            size="sm"
          />
          <span className="min-w-0 flex-1 truncate">外观</span>
          <MenuRadioGroup
            aria-label="外观"
            className="flex gap-0.5"
            onValueChange={(value) => {
              const next = THEME_PREFERENCES.find((item) => item === value)
              if (next !== undefined) setThemePreference(next)
            }}
            value={appearance}
          >
            {THEME_PREFERENCES.map((item) => (
              <MenuIconRadioItem
                icon={APPEARANCE[item].icon}
                key={item}
                label={APPEARANCE[item].label}
                value={item}
              />
            ))}
          </MenuRadioGroup>
        </div>
        <MenuItem disabled icon="settings">
          <span className="flex items-center justify-between gap-2">
            设置
            <span className="text-caption text-on-surface-faint">即将上线</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon="logout"
          disabled={isLoggingOut}
          className="data-disabled:cursor-wait"
          onSelect={(event) => {
            event.preventDefault()
            handleLogout()
          }}
        >
          {isLoggingOut ? '退出中' : '退出登录'}
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

function CueUserAvatarIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      data-cue-user-avatar-icon="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="8.25" r="3.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M5.75 19.25c.78-3.08 3.07-5 6.25-5s5.47 1.92 6.25 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}
