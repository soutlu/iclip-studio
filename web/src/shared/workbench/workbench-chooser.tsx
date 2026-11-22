import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { CreatableEntry } from './artifact'
import { RAISED_CARD_HOVER_CLASS } from './workbench-button'

export type ChooserRow = {
  key: string
  label: string
  icon: IconName
  artifactId?: string
  detail?: string
}

const ROW_CLASS =
  'flex h-10.5 w-full items-center gap-2.5 rounded-md px-3 text-left text-ui font-medium ui-focus'

const TAG_CLASS =
  'ml-auto flex shrink-0 items-center gap-0.75 text-caption font-medium text-on-surface-faint'

type ChooserProps = {
  rows: readonly ChooserRow[]
  creatable: readonly CreatableEntry[]
  creating: string | undefined
  onPick: (id: string) => void
  onCreate: (entry: CreatableEntry) => void
}

/**
 * 没选中任何页签时工作台正中的卡片：能打开的产物一行一个（还没有的灰着、写原因），分隔线下是能新建的类型。
 */
export function Chooser({ rows, creatable, creating, onPick, onCreate }: ChooserProps) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 pb-6">
      <nav
        aria-label="能打开的产物"
        className="flex w-full max-w-86 flex-col gap-0.75 rounded-panel bg-surface p-1.75 shadow-[var(--shadow-panel),var(--shadow-specular)]"
      >
        <ul className="flex flex-col gap-0.75">
          {rows.map((row) => {
            const enabled = row.artifactId !== undefined
            return (
              <li key={row.key}>
                <button
                  aria-disabled={enabled ? undefined : true}
                  className={cn(
                    ROW_CLASS,
                    enabled
                      ? 'ui-state cursor-pointer text-on-surface'
                      : 'cursor-default text-on-surface-faint',
                  )}
                  onClick={() => {
                    if (row.artifactId !== undefined) onPick(row.artifactId)
                  }}
                  type="button"
                >
                  <Icon
                    className={cn(
                      'shrink-0',
                      enabled ? 'text-on-surface-variant' : 'text-on-surface-faint',
                    )}
                    decorative
                    name={row.icon}
                  />
                  <span className="min-w-0 truncate">{row.label}</span>
                  {row.detail === undefined ? null : (
                    <span className={TAG_CLASS}>{row.detail}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        {creatable.length === 0 ? null : (
          <>
            <div aria-hidden className="mx-2 my-1 h-px bg-panel-line" />
            <ul className="flex flex-col gap-0.75">
              {creatable.map((entry) => {
                const busy = creating !== undefined
                return (
                  <li key={entry.type}>
                    <button
                      aria-disabled={busy ? true : undefined}
                      aria-label={`新建 ${entry.label}`}
                      className={cn(
                        ROW_CLASS,
                        'bg-card font-semibold text-on-surface shadow-[var(--shadow-panel-card),var(--shadow-specular)]',
                        busy
                          ? 'cursor-default'
                          : ['ui-state cursor-pointer', RAISED_CARD_HOVER_CLASS],
                      )}
                      onClick={() => {
                        if (!busy) onCreate(entry)
                      }}
                      type="button"
                    >
                      <Icon
                        className={cn(
                          'shrink-0',
                          creating === entry.type ? 'animate-spin' : 'text-tone-copper',
                        )}
                        decorative
                        name={creating === entry.type ? 'loading' : entry.icon}
                      />
                      <span className="min-w-0 truncate">{entry.label}</span>
                      <span className={TAG_CLASS}>
                        新建
                        <Icon decorative name="disclosure" size="sm" />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </nav>
    </div>
  )
}
