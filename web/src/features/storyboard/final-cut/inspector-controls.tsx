import { useEffect, useRef, useState } from 'react'
import { Input } from '@/shared/ui/field'
import { Slider } from '@/shared/ui/slider'

/**
 * 「属性」里的滑杆加右边的数值：滑杆按格走（`position` 是格数），拖的时候数值跟着变，松手（或按一下方向键）
 * 才交给 `onCommit`。点数值可以直接输入，见 `Readout`。
 */
export function SliderControl({
  label,
  min,
  max,
  step = 1,
  position,
  text,
  format,
  mark,
  disabled = false,
  onCommit,
  onText,
  onEditing,
  onDoubleClick,
  onDrag,
}: {
  label: string
  min: number
  max: number
  step?: number
  position: number
  /** 现在的取值怎么显示。 */
  text: string
  /** 拖到 `position` 这一格时怎么显示。 */
  format: (position: number) => string
  /** 在这一格画一道刻度。 */
  mark?: number
  disabled?: boolean
  onCommit: (position: number) => void
  onText: (text: string) => boolean
  onEditing: (editing: boolean) => void
  onDoubleClick?: () => void
  /** 拖到了 `position` 这一格（还没松手），给要跟着拖动变的旁边的东西用。 */
  onDrag?: (position: number) => void
}) {
  // 拖到的格数，连同开始拖时的取值：取值被撤销、输入改掉以后不再用它
  const [dragged, setDragged] = useState<{ from: number; to: number } | null>(null)
  const draft = dragged !== null && dragged.from === position ? dragged.to : null
  const shown = draft === null ? text : format(draft)
  return (
    <span className="wf-prop-slider">
      <Slider
        className="min-w-0 flex-1"
        disabled={disabled}
        label={label}
        mark={mark}
        max={max}
        min={min}
        onChange={(to) => {
          setDragged({ from: position, to })
          onDrag?.(to)
        }}
        onCommit={(to) => {
          setDragged(null)
          onCommit(to)
        }}
        onDoubleClick={onDoubleClick}
        step={step}
        value={draft ?? Math.min(max, Math.max(min, position))}
        valueText={shown}
      />
      <Readout
        disabled={disabled}
        label={label}
        onEditing={onEditing}
        onText={onText}
        text={shown}
      />
    </span>
  )
}

/**
 * 滑杆右边的数值：点一下变成输入框。回车或失焦交给 `onText`，它返回 false 表示读不出——
 * 回车时框留着、标成不对，失焦时放弃；Esc 放弃。
 */
function Readout({
  label,
  text,
  disabled,
  onText,
  onEditing,
}: {
  label: string
  text: string
  disabled: boolean
  onText: (text: string) => boolean
  onEditing: (editing: boolean) => void
}) {
  const [typing, setTyping] = useState<{ text: string; invalid: boolean } | null>(null)
  // 回车、Esc 时先定下结果再失焦，失焦的处理读这里，不等重新渲染；null 是不用再交
  const typedRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editing = typing !== null
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])
  // 框还聚焦着就被卸掉（换了选中的片段）时收不到失焦，这里补一下
  useEffect(() => () => onEditing(false), [onEditing])
  if (typing === null)
    return (
      <button
        aria-label={`${label} ${text}，点击可直接输入`}
        className="wf-prop-readout ui-state ui-focus"
        disabled={disabled}
        onClick={() => {
          typedRef.current = text
          setTyping({ text, invalid: false })
        }}
        type="button"
      >
        {text}
      </button>
    )
  return (
    <Input
      aria-invalid={typing.invalid || undefined}
      aria-label={label}
      autoComplete="off"
      className="wf-field wf-prop-readout-input"
      onBlur={() => {
        onEditing(false)
        const typed = typedRef.current
        typedRef.current = null
        setTyping(null)
        if (typed !== null) onText(typed.trim())
      }}
      onChange={(event) => {
        typedRef.current = event.target.value
        setTyping({ text: event.target.value, invalid: false })
      }}
      onFocus={() => onEditing(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (!onText(typing.text.trim())) {
            setTyping({ ...typing, invalid: true })
            event.currentTarget.select()
            return
          }
          typedRef.current = null
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          typedRef.current = null
          event.currentTarget.blur()
        }
      }}
      ref={inputRef}
      spellCheck={false}
      value={typing.text}
    />
  )
}
