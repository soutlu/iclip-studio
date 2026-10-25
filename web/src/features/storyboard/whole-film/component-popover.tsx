import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import {
  isLightColor,
  swatchColors,
  variableValue,
  type CatalogItem,
  type CatalogVariable,
  type VariableValue,
} from './component-catalog'
import { ComponentThumb } from './components-panel'
import type { ComponentVariables } from './editing/draft'

const UNIT_TEXT: Record<string, string> = { s: '秒', px: '像素', '%': '%', deg: '°' }

/** 选项不超过这么多时用分段按钮，更多时用下拉 */
const SEGMENTED_MAX = 4

type ComponentPopoverProps = {
  item: CatalogItem
  values: ComponentVariables
  onChange: (values: ComponentVariables) => void
  onRemove: () => void
}

/**
 * 组件段与特效块共用的调整浮层：一行一项列出组件的全部可填项。文字项没填过时空着、组件的默认字作
 * 灰色提示，清空即回到默认字。每次改动是一步编辑，只影响这条成片。
 */
export function ComponentPopover({ item, values, onChange, onRemove }: ComponentPopoverProps) {
  const set = (id: string, value: VariableValue | undefined) => {
    if (values[id] === value) return
    onChange(
      value === undefined
        ? Object.fromEntries(Object.entries(values).filter(([key]) => key !== id))
        : { ...values, [id]: value },
    )
  }
  return (
    <div className="wf-pop">
      <div className="wf-pop-head">
        <ComponentThumb className="wf-pop-thumb" iconSize="xs" item={item} />
        <b>{item.title}</b>
        <IconButton
          className="wf-pop-remove"
          label="移除"
          name="delete"
          onClick={onRemove}
          size="sm"
        />
      </div>
      {item.variables.map((variable) => (
        <VariableField
          key={variable.id}
          onChange={(value) => set(variable.id, value)}
          values={values}
          variable={variable}
        />
      ))}
    </div>
  )
}

type FieldProps = {
  variable: CatalogVariable
  values: ComponentVariables
  /** undefined 表示不再填，回到组件的默认值 */
  onChange: (value: VariableValue | undefined) => void
}

function VariableField({ variable, values, onChange }: FieldProps) {
  const id = useId()
  const labelId = `${id}-label`
  const stored = values[variable.id]
  const value = variableValue(variable, values)
  // 输入框、开关用 label 关联；分段按钮、色块这类一组按钮用 aria-labelledby
  let labelFor: string | undefined = id
  let input: ReactNode
  switch (variable.type) {
    case 'string':
    case 'font':
      input = (
        <CommitInput
          id={id}
          key={String(stored)}
          onCommit={(text) => onChange(text.trim() === '' ? undefined : text)}
          placeholder={String(variable.default)}
          type="text"
          value={stored === undefined ? '' : String(stored)}
        />
      )
      break
    case 'number':
      input = (
        <span className="wf-field-number">
          <CommitInput
            id={id}
            key={String(value)}
            max={variable.max}
            min={variable.min}
            onCommit={(text) => {
              const number = Number(text)
              if (text.trim() !== '' && Number.isFinite(number)) onChange(number)
            }}
            step={variable.step}
            type="number"
            value={String(value)}
          />
          {variable.unit === undefined ? null : (UNIT_TEXT[variable.unit] ?? variable.unit)}
        </span>
      )
      break
    case 'enum': {
      const options = variable.options ?? []
      if (options.length <= SEGMENTED_MAX) {
        labelFor = undefined
        input = (
          <span aria-labelledby={labelId} className="wf-segments" role="group">
            {options.map((option) => (
              <button
                aria-pressed={option.value === value}
                className="ui-focus"
                key={option.value}
                onClick={() => onChange(option.value)}
                title={option.label}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </span>
        )
        break
      }
      const current = options.find((option) => option.value === value) ?? options[0]
      input = (
        <MenuRoot>
          <MenuTrigger asChild>
            <button className="wf-select ui-state ui-focus" id={id} type="button">
              {current?.label ?? String(value)}
              <Icon decorative name="expand" size="xs" />
            </button>
          </MenuTrigger>
          <MenuSurface align="start" side="top">
            <MenuRadioGroup onValueChange={onChange} value={String(value)}>
              {options.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>
      )
      break
    }
    case 'color': {
      const current = String(value)
      labelFor = undefined
      input = (
        <span aria-labelledby={labelId} className="wf-swatches" role="group">
          {swatchColors(String(variable.default), current).map((color) => {
            const pressed = color.toLowerCase() === current.toLowerCase()
            return (
              <button
                aria-label={color}
                aria-pressed={pressed}
                className={cn('wf-swatch ui-focus', isLightColor(color) && 'is-light')}
                key={color}
                onClick={() => onChange(color)}
                style={{ '--wf-swatch': color } as CSSProperties}
                type="button"
              >
                {pressed ? <Icon decorative name="check" size="xs" /> : null}
              </button>
            )
          })}
          <ColorInput onCommit={onChange} value={current} />
        </span>
      )
      break
    }
    case 'boolean':
      input = (
        <span>
          <button
            aria-checked={value === true}
            className="wf-switch ui-focus"
            id={id}
            onClick={() => onChange(value !== true)}
            role="switch"
            type="button"
          >
            <i />
          </button>
        </span>
      )
      break
    case 'image':
      labelFor = undefined
      input = <span className="wf-field-static">默认图片</span>
      break
  }
  return (
    <div className="wf-field">
      {labelFor === undefined ? (
        <span id={labelId} title={variable.label}>
          {variable.label}
        </span>
      ) : (
        <label htmlFor={labelFor} id={labelId} title={variable.label}>
          {variable.label}
        </label>
      )}
      {input}
    </div>
  )
}

/** 其他颜色：系统取色器关上（原生 change）时记一步编辑，拖动取色的过程不记 */
function ColorInput({ value, onCommit }: { value: string; onCommit: (color: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const commitRef = useRef(onCommit)
  useLayoutEffect(() => {
    commitRef.current = onCommit
  })
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const onChange = () => commitRef.current(element.value)
    element.addEventListener('change', onChange)
    return () => element.removeEventListener('change', onChange)
  }, [])
  return (
    <input
      aria-label="其他颜色"
      className="wf-color ui-focus"
      defaultValue={/^#[0-9a-f]{6}$/i.test(value) ? value : undefined}
      key={value}
      ref={ref}
      title="其他颜色"
      type="color"
    />
  )
}

type CommitInputProps = {
  id: string
  type: 'text' | 'number'
  value: string
  placeholder?: string
  min?: number | undefined
  max?: number | undefined
  step?: number | undefined
  onCommit: (text: string) => void
}

/** 输入时只改显示，回车或离开输入框才记一步编辑；Esc 放弃这次输入 */
function CommitInput({ id, type, value, placeholder, min, max, step, onCommit }: CommitInputProps) {
  const [text, setText] = useState(value)
  const commit = () => {
    if (text !== value) onCommit(text)
  }
  return (
    <input
      className="wf-input ui-focus ui-focus-inline"
      id={id}
      max={max}
      min={min}
      onBlur={commit}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setText(value)
      }}
      placeholder={placeholder}
      step={step}
      type={type}
      value={text}
    />
  )
}
