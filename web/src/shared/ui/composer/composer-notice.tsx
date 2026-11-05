import { Icon } from '@/shared/icons'

export function ComposerNotice({ notice }: { notice: string | null }) {
  return (
    <div aria-live="polite" data-testid="composer-notice">
      {notice === null ? null : (
        <p className="composer-notice">
          <Icon decorative name="info" size="sm" />
          {notice}
        </p>
      )}
    </div>
  )
}
