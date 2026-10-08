/** 详情里的一组标签：每个是一小块，能改时带「去掉」，最后一个「+」从清单里挑一个加上。改动交给调用方去保存。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { SearchPicker } from '@/shared/ui/search-picker'
import { Tag } from '@/shared/ui/tag'

type TagOption = { id: string; label: string }

type ReferenceTagRowProps = {
  /** 这一组的名字，如「片子类型」。 */
  label: string
  /** 已打的标签，按显示的先后。 */
  values: readonly TagOption[]
  /** 能加的全部候选；已打的不再列出。 */
  options: readonly TagOption[]
  /** 能改：小块带「去掉」，末尾有「+」。 */
  editable: boolean
  /** 正在保存：先不接新的改动。 */
  busy: boolean
  /** 没有标签时的说明，如「未标注」。 */
  emptyText: string
  onChange: (ids: string[]) => void
}

export function ReferenceTagRow({
  label,
  values,
  options,
  editable,
  busy,
  emptyText,
  onChange,
}: ReferenceTagRowProps) {
  const [adding, setAdding] = useState(false)
  const ids = values.map((value) => value.id)
  const addable = options.filter((option) => !ids.includes(option.id))

  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 pt-0.5 text-body-sm text-on-surface-faint">{label}</span>
      <ul aria-label={label} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {values.length === 0 ? (
          <li className="text-body-sm text-on-surface-faint">{emptyText}</li>
        ) : (
          values.map((value) => (
            <li className="min-w-0" key={value.id}>
              <Tag className="h-auto min-h-(--control-height-xs) max-w-full bg-surface-container py-0.5 break-all">
                {value.label}
                {editable ? (
                  <button
                    aria-label={`去掉${value.label}`}
                    className="-mr-1 grid size-4 shrink-0 ui-state cursor-pointer place-items-center rounded-xs text-on-surface-faint ui-focus hover:text-on-surface disabled:cursor-not-allowed"
                    disabled={busy}
                    onClick={() => onChange(ids.filter((id) => id !== value.id))}
                    type="button"
                  >
                    <Icon decorative name="close" size="xs" />
                  </button>
                ) : null}
              </Tag>
            </li>
          ))
        )}
        {editable ? (
          <li>
            <PopupRoot onOpenChange={setAdding} open={adding}>
              <PopupTrigger asChild>
                <IconButton
                  className="h-(--control-height-xs) w-6 rounded-xs border border-dashed border-outline-variant text-on-surface-variant"
                  disabled={busy || addable.length === 0}
                  label={`添加${label}`}
                  name="add"
                  size="xs"
                />
              </PopupTrigger>
              <PopupSurface
                align="start"
                aria-label={`添加${label}`}
                className="w-60"
                sideOffset={6}
              >
                {adding ? (
                  <SearchPicker
                    label={label}
                    onChange={(id) => {
                      setAdding(false)
                      if (id !== null) onChange([...ids, id])
                    }}
                    source={{
                      error: undefined,
                      isPending: false,
                      onRetry: undefined,
                      options: addable,
                    }}
                    value={null}
                  />
                ) : null}
              </PopupSurface>
            </PopupRoot>
          </li>
        ) : null}
      </ul>
    </div>
  )
}
