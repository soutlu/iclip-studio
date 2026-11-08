import {
  createContext,
  use,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'

export type SearchListOption = { id: string; label: string }

type SearchListContextValue = {
  matches: readonly SearchListOption[]
  query: string
  changeQuery: (query: string) => void
  isSelected: (id: string) => boolean
  multiple: boolean
  activeId: string | null
  setActiveId: (id: string | null) => void
  disabled: boolean
  pending: boolean
  error: string | undefined
  listId: string
  listRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  select: (id: string) => void
  focusInput: () => void
  handleInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

const SearchListContext = createContext<SearchListContextValue | null>(null)

const useSearchListContext = (): SearchListContextValue => {
  const context = use(SearchListContext)
  if (context === null) throw new Error('SearchList 的子组件必须放在 SearchListRoot 内')
  return context
}

const OPTION_CLASS =
  'flex min-h-10 w-full ui-state cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-left text-body text-on-surface ui-focus disabled:cursor-not-allowed disabled:text-disabled-text'

type SearchListRootProps = {
  options: readonly SearchListOption[]
  value: string | null | readonly string[]
  onSelect: (id: string) => void
  disabled?: boolean | undefined
  pending?: boolean | undefined
  error?: string | undefined
  className?: string | undefined
  children: ReactNode
}

export function SearchListRoot({
  options,
  value,
  onSelect,
  disabled = false,
  pending = false,
  error,
  className,
  children,
}: SearchListRootProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const search = query.trim().toLocaleLowerCase()
  const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(search))
  const activeIndex = matches.findIndex((option) => option.id === activeId)
  const activeOption = matches[activeIndex]
  const multiple = Array.isArray(value)
  const isSelected = (id: string) => (Array.isArray(value) ? value.includes(id) : value === id)

  const changeQuery = (next: string) => {
    setQuery(next)
    setActiveId(null)
  }
  const focusInput = () => inputRef.current?.focus()
  const moveTo = (index: number) => {
    const option = matches[index]
    if (!option) return
    setActiveId(option.id)
    listRef.current?.children.item(index)?.scrollIntoView({ block: 'nearest' })
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      disabled ||
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !matches.length
    )
      return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveTo((activeIndex + 1) % matches.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveTo((activeIndex > 0 ? activeIndex : matches.length) - 1)
        break
      case 'Home':
        event.preventDefault()
        moveTo(0)
        break
      case 'End':
        event.preventDefault()
        moveTo(matches.length - 1)
        break
      case 'Enter':
        if (activeOption) {
          event.preventDefault()
          onSelect(activeOption.id)
        }
        break
    }
  }

  return (
    <SearchListContext
      value={{
        matches,
        query,
        changeQuery,
        isSelected,
        multiple,
        activeId,
        setActiveId,
        disabled,
        pending,
        error,
        listId,
        listRef,
        inputRef,
        select: onSelect,
        focusInput,
        handleInputKeyDown,
      }}
    >
      <div className={cn('flex flex-col gap-2 text-on-surface', className)}>{children}</div>
    </SearchListContext>
  )
}

export function useSearchList(): {
  query: string
  setQuery: (query: string) => void
  focusInput: () => void
} {
  const { query, changeQuery, focusInput } = useSearchListContext()
  return { query, setQuery: changeQuery, focusInput }
}

type SearchListInputProps = {
  label: string
  trailingAction?: ReactNode
  wrapperClassName?: string | undefined
}

export function SearchListInput({ label, trailingAction, wrapperClassName }: SearchListInputProps) {
  const { matches, query, changeQuery, activeId, disabled, listId, inputRef, handleInputKeyDown } =
    useSearchListContext()
  const activeOption = matches.find((option) => option.id === activeId)
  return (
    <Input
      aria-activedescendant={activeOption ? optionDomId(listId, activeOption.id) : undefined}
      aria-autocomplete="list"
      aria-controls={listId}
      aria-expanded
      aria-label={label}
      autoComplete="off"
      className="text-body"
      disabled={disabled}
      leadingIcon="search"
      onChange={(event) => changeQuery(event.target.value)}
      onKeyDown={handleInputKeyDown}
      placeholder={label}
      ref={inputRef}
      role="combobox"
      trailingAction={trailingAction}
      value={query}
      wrapperClassName={cn(
        'h-10 shrink-0 rounded-sm border-transparent bg-surface-container-low px-3',
        wrapperClassName,
      )}
    />
  )
}

export type SearchListOptionState = { selected: boolean; active: boolean }

type SearchListOptionsProps = {
  label: string
  className?: string | undefined
  renderOption?: ((option: SearchListOption, state: SearchListOptionState) => ReactNode) | undefined
}

export function SearchListOptions({
  label,
  className,
  renderOption = (option, { selected }) => (
    <SearchListOptionContent option={option} selected={selected} />
  ),
}: SearchListOptionsProps) {
  const {
    matches,
    isSelected,
    multiple,
    activeId,
    setActiveId,
    disabled,
    pending,
    listId,
    listRef,
    select,
  } = useSearchListContext()
  return (
    <div
      aria-busy={pending}
      aria-label={label}
      aria-multiselectable={multiple || undefined}
      className={cn('max-h-72 shrink-0 overflow-y-auto overscroll-contain', className)}
      id={listId}
      ref={listRef}
      role="listbox"
    >
      {matches.map((option) => {
        const selected = isSelected(option.id)
        const active = option.id === activeId
        return (
          <button
            aria-selected={selected}
            className={cn(OPTION_CLASS, selected && 'bg-state-active', active && 'bg-state-focus')}
            disabled={disabled}
            id={optionDomId(listId, option.id)}
            key={option.id}
            onClick={() => select(option.id)}
            onPointerDown={(event) => {
              if (event.button === 0) event.preventDefault()
            }}
            onPointerMove={() => setActiveId(option.id)}
            role="option"
            tabIndex={-1}
            title={option.label}
            type="button"
          >
            {renderOption(option, { selected, active })}
          </button>
        )
      })}
    </div>
  )
}

type SearchListOptionContentProps = {
  option: SearchListOption
  selected: boolean
  leading?: ReactNode
}

export function SearchListOptionContent({
  option,
  selected,
  leading,
}: SearchListOptionContentProps) {
  return (
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate">
        <HighlightedLabel text={option.label} />
      </span>
      {selected ? <Icon className="shrink-0" decorative name="check" size="sm" /> : null}
    </>
  )
}

function HighlightedLabel({ text }: { text: string }) {
  const { query } = useSearchListContext()
  const search = query.trim()
  const start = search ? text.toLocaleLowerCase().indexOf(search.toLocaleLowerCase()) : -1
  if (start < 0) return text
  return (
    <>
      {text.slice(0, start)}
      <span className="font-medium text-primary">{text.slice(start, start + search.length)}</span>
      {text.slice(start + search.length)}
    </>
  )
}

type SearchListStatusProps = {
  label: string
  onRetry?: (() => void) | undefined
  renderEmpty?: ((query: string) => ReactNode) | undefined
}

export function SearchListStatus({ label, onRetry, renderEmpty }: SearchListStatusProps) {
  const { matches, query, pending, error, disabled, focusInput } = useSearchListContext()
  if (pending) {
    return (
      <p className="px-3 py-6 text-center text-body-sm text-on-surface-variant" role="status">
        正在加载{label}…
      </p>
    )
  }
  if (error) {
    return (
      <div className="px-3 py-5 text-center">
        <p className="text-body-sm text-error" role="alert">
          {error}
        </p>
        {onRetry ? (
          <Button
            className="mt-2 text-primary"
            disabled={disabled}
            onClick={() => {
              onRetry()
              focusInput()
            }}
            size="md"
            variant="ghost"
          >
            重新加载
          </Button>
        ) : null}
      </div>
    )
  }
  if (matches.length) return null
  const search = query.trim()
  return (
    <div className="px-3 py-6 text-center text-body-sm text-on-surface-variant" role="status">
      {renderEmpty ? renderEmpty(search) : search ? `暂无匹配的${label}` : `暂无可选${label}`}
    </div>
  )
}

const optionDomId = (listId: string, optionId: string) => `${listId}-${optionId}`
