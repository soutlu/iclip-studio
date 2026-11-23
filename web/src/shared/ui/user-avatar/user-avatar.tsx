import { cn } from '@/shared/lib/utils'

type UserAvatarProps = {
  /** 头像图片 URL；为空时回退显示姓名首字符。 */
  avatarUrl: string
  /** 用于提取首字符的显示名称；为空时回退显示通用头像轮廓。 */
  name: string
  className?: string
}

/** 装饰性圆形用户头像（无障碍名称由相邻文本提供）：依次回退为图片、姓名首字符、通用轮廓图标。 */
export function UserAvatar({ avatarUrl, className, name }: UserAvatarProps) {
  const url = avatarUrl.trim()
  const initial = name.trim().charAt(0).toUpperCase()
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-8 shrink-0 place-items-center overflow-hidden rounded-full text-label font-semibold',
        url
          ? 'border border-border bg-top-layer text-on-surface'
          : 'bg-surface-container-high text-on-surface-variant',
        className,
      )}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : initial ? (
        initial
      ) : (
        <GenericAvatarIcon />
      )}
    </span>
  )
}

function GenericAvatarIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
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
