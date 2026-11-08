import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import {
  SearchListInput,
  SearchListOptionContent,
  SearchListOptions,
  SearchListRoot,
  SearchListStatus,
} from '@/shared/ui/search-list'
import { Tag } from '@/shared/ui/tag'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  dimensionEntriesOf,
  isAiDimension,
  replaceDimensionTags,
  tagOptionsOf,
  type LibraryTag,
  type TagEntry,
  type TagIndex,
  type TagOption,
} from '../library-tags'

type LibraryTagEditorProps = {
  index: TagIndex
  value: readonly string[]
  editable: boolean
  busy: boolean
  onChange: (tags: string[]) => void
  aiHint: string
}

export function LibraryTagEditor({
  index,
  value,
  editable,
  busy,
  onChange,
  aiHint,
}: LibraryTagEditorProps) {
  return (
    <div className="grid gap-2.5">
      {index.dimensions.map((dimension) => (
        <TagRow
          aiHint={aiHint}
          busy={busy}
          dimension={dimension}
          editable={editable}
          key={dimension.id}
          onChange={(ids) => onChange(replaceDimensionTags(index, value, dimension.id, ids))}
          values={dimensionEntriesOf(index, dimension.id, value)}
        />
      ))}
    </div>
  )
}

type TagRowProps = {
  dimension: LibraryTag
  values: readonly TagEntry[]
  editable: boolean
  busy: boolean
  onChange: (ids: string[]) => void
  aiHint: string
}

function TagRow({ dimension, values, editable, busy, onChange, aiHint }: TagRowProps) {
  const [adding, setAdding] = useState(false)
  const [pickerHost, setPickerHost] = useState<HTMLLIElement | null>(null)
  const label = dimension.name
  const ids = values.map((value) => value.id)
  const addable = tagOptionsOf(dimension).filter((option) => !ids.includes(option.id))

  return (
    <div aria-label={label} className="flex items-start gap-3" role="group">
      <span className="flex w-20 shrink-0 items-center gap-1 pt-0.5 text-body-sm text-on-surface-faint">
        <span className="truncate">{label}</span>
        {isAiDimension(dimension) ? <AiHint hint={aiHint} /> : null}
      </span>
      <ul aria-label={label} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {values.length === 0 ? (
          <li className="text-body-sm text-on-surface-faint">未标注</li>
        ) : (
          values.map((value) => (
            <li className="min-w-0" key={value.id}>
              <Tag className="h-auto min-h-(--control-height-xs) max-w-full bg-surface-container py-0.5 break-all">
                {value.name}
                {editable ? (
                  <button
                    aria-label={`移除${value.name}`}
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
          <li ref={setPickerHost}>
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
                container={pickerHost}
                sideOffset={6}
              >
                {adding ? (
                  <AddPicker
                    label={label}
                    onPick={(id) => {
                      setAdding(false)
                      onChange([...ids, id])
                    }}
                    options={addable}
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

function AiHint({ hint }: { hint: string }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span className="grid shrink-0 place-items-center">
          <Icon label={hint} name="sparkles" size="xs" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </TooltipRoot>
  )
}

function AddPicker({
  label,
  options,
  onPick,
}: {
  label: string
  options: readonly TagOption[]
  onPick: (id: string) => void
}) {
  return (
    <SearchListRoot className="p-2.5" onSelect={onPick} options={options} value={null}>
      <SearchListInput label={`搜索${label}`} />
      <SearchListOptions
        label={label}
        renderOption={(option, { selected }) => {
          const tag = options.find((candidate) => candidate.id === option.id)
          return (
            <span
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2.5',
                tag?.depth === 1 && 'pl-4',
                tag?.depth === 2 && 'pl-8',
                tag?.group === true && 'font-medium',
              )}
            >
              <SearchListOptionContent option={option} selected={selected} />
            </span>
          )
        }}
      />
      <SearchListStatus label={label} />
    </SearchListRoot>
  )
}
