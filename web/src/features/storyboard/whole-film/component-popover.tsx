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
import { Button } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import {
  variableValue,
  type CatalogItem,
  type CatalogVariable,
  type VariableValue,
} from './component-catalog'
import type { ComponentVariables } from './editing/draft'

const UNIT_TEXT: Record<string, string> = { s: '秒', px: '像素', '%': '%', deg: '度' }

type ComponentPopoverProps = {
  item: CatalogItem
  values: ComponentVariables
  /** 浮层标题，如「片头 · 标志定格」 */
  heading: string
  /** 标题旁的时长、位置与可拖的边 */
  meta: string
  removeLabel: string
  onChange: (values: ComponentVariables) => void
  onRemove: () => void
}

/**
 * 成片轨上组件（片头片尾、包装、转场）的浮层：按组件目录列出全部可填项，没填过的显示组件自己的
 * 默认值。每次改动是一步编辑，只影响这条整片。
 */
export function ComponentPopover({
  item,
  values,
  heading,
  meta,
  removeLabel,
  onChange,
  onRemove,
}: ComponentPopoverProps) {
  const set = (id: string, value: VariableValue) => {
    if (values[id] === value) return
    onChange({ ...values, [id]: value })
  }
  return (
    <div className="wf-pop">
      <div className="wf-pop-head">
        <b>{heading}</b>
        <Button className="wf-pop-remove" onClick={onRemove} size="md" variant="ghost">
          {removeLabel}
        </Button>
      </div>
      <p className="wf-pop-meta">{meta}</p>
      <p className="wf-pop-desc">{item.description}</p>
      {item.variables.length === 0 ? (
        <p className="wf-pop-note">这个组件没有可调的项</p>
      ) : (
        item.variables.map((variable) => (
          <VariableField
            key={variable.id}
            onChange={(value) => set(variable.id, value)}
            value={variableValue(variable, values)}
            variable={variable}
          />
        ))
      )}
      <p className="wf-pop-note">只影响这条整片</p>
    </div>
  )
}

type FieldProps = {
  variable: CatalogVariable
  value: VariableValue
  onChange: (value: VariableValue) => void
}

function VariableField({ variable, value, onChange }: FieldProps) {
  const id = useId()
  const label = (
    <label htmlFor={id} title={variable.label}>
      {variable.label}
    </label>
  )
  let input: ReactNode
  switch (variable.type) {
    case 'string':
    case 'font':
      input = (
        <CommitInput
          id={id}
          key={String(value)}
          onCommit={(text) => onChange(text)}
          type="text"
          value={String(value)}
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
      const current = String(value).toLowerCase()
      input = (
        <span className="wf-swatches" role="group">
          <button
            aria-label={current}
            aria-pressed
            className="wf-swatch ui-focus"
            onClick={() => onChange(current)}
            style={{ '--wf-swatch': current } as CSSProperties}
            type="button"
          />
          <ColorInput id={id} onCommit={onChange} value={current} />
        </span>
      )
      break
    }
    case 'boolean':
      input = (
        <span>
          <button
            aria-checked={value === true}
            aria-label={variable.label}
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
      input = (
        <span className="wf-field-static" id={id}>
          用组件自带的图片
        </span>
      )
      break
  }
  return (
    <div className="wf-field">
      {label}
      {input}
    </div>
  )
}

/** 自选颜色：系统取色器关上（原生 change）时记一步编辑，拖动取色的过程不记 */
function ColorInput({
  id,
  value,
  onCommit,
}: {
  id: string
  value: string
  onCommit: (color: string) => void
}) {
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
      aria-label="自选颜色"
      className="wf-color ui-focus"
      defaultValue={/^#[0-9a-f]{6}$/.test(value) ? value : undefined}
      id={id}
      key={value}
      ref={ref}
      type="color"
    />
  )
}

type CommitInputProps = {
  id: string
  type: 'text' | 'number'
  value: string
  min?: number | undefined
  max?: number | undefined
  step?: number | undefined
  onCommit: (text: string) => void
}

/** 输入时只改显示，回车或离开输入框才记一步编辑；Esc 放弃这次输入 */
function CommitInput({ id, type, value, min, max, step, onCommit }: CommitInputProps) {
  const [text, setText] = useState(value)
  const commit = () => {
    if (text !== value) onCommit(text)
  }
  return (
    <input
      className="wf-input ui-focus"
      id={id}
      max={max}
      min={min}
      onBlur={commit}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setText(value)
      }}
      step={step}
      type={type}
      value={text}
    />
  )
}
