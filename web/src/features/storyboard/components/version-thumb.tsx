import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { versionThumbSize } from './version-thumb-size'

const sizeOf = (ratio: string | undefined): CSSProperties | undefined =>
  ratio === undefined ? undefined : versionThumbSize(ratio)

type VersionThumbProps = {
  name: string
  label?: string | undefined
  selected: boolean
  onClick: () => void
  disabled?: boolean | undefined
  ratio?: string | undefined
  unseen?: boolean | undefined
  state?: ReactNode
  children: ReactNode
}

export function VersionThumb({
  name,
  label,
  selected,
  onClick,
  disabled,
  ratio,
  unseen = false,
  state,
  children,
}: VersionThumbProps) {
  return (
    <button
      aria-label={name}
      aria-pressed={selected}
      className="version-thumb ui-focus"
      disabled={disabled}
      onClick={onClick}
      style={sizeOf(ratio)}
      title={name}
      type="button"
    >
      {children}
      {state === undefined ? null : <span className="version-thumb-state">{state}</span>}
      {unseen ? <span aria-label="新结果" className="version-thumb-dot" role="img" /> : null}
      {label === undefined ? null : <span className="version-thumb-label">{label}</span>}
    </button>
  )
}

type VersionTileProps = {
  icon: ReactNode
  label: string
  title: string
  onClick: () => void
  disabled?: boolean | undefined
  selected?: boolean | undefined
  ratio?: string | undefined
  className?: string | undefined
}

export function VersionTile({
  icon,
  label,
  title,
  onClick,
  disabled,
  selected,
  ratio,
  className,
}: VersionTileProps) {
  return (
    <button
      aria-pressed={selected}
      className={cn('version-thumb version-thumb-tile ui-focus', className)}
      disabled={disabled}
      onClick={onClick}
      style={sizeOf(ratio)}
      title={title}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
