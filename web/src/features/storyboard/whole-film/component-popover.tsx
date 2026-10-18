import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { BrandProfile } from '@/shared/api/brand-templates'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import {
  brandOf,
  variableValue,
  withBrand,
  type CatalogItem,
  type CatalogVariable,
  type VariableValue,
} from './component-catalog'
import type { ComponentVariables } from './editing/draft'

const UNIT_TEXT: Record<string, string> = { s: '秒', px: '像素', '%': '%', deg: '度' }

type ComponentPopoverProps = {
  item: CatalogItem
  values: ComponentVariables
  brands: readonly BrandProfile[]
  /** 浮层标题，如「片头 · 标志定格」 */
  heading: string
  /** 标题旁的时长、位置与可拖的边 */
  meta: string
  removeLabel: string
  onChange: (values: ComponentVariables) => void
  onRemove: () => void
}

/**
 * 成片轨上组件（片头片尾、包装、转场）的浮层：按组件目录列出全部可填项，对得上品牌模板的项注明
 * 默认取自品牌模板；有多个品牌时可以换一个品牌来填。每次改动是一步编辑，只影响这条整片。
 */
export function ComponentPopover({
  item,
  values,
  brands,
  heading,
  meta,
  removeLabel,
  onChange,
  onRemove,
}: ComponentPopoverProps) {
  const hasBrandFields = item.variables.some((variable) => variable.brand !== undefined)
  const brand = brandOf(item, values, brands)
  // 颜色项的候选：各品牌的强调色，当前品牌的排前面
  const accents = [
    ...new Set(
      [brand, ...brands].flatMap((item) =>
        item?.accentColor == null ? [] : [item.accentColor.toLowerCase()],
      ),
    ),
  ]
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
      {hasBrandFields && brands.length > 1 ? (
        <div className="wf-field">
          <span>品牌</span>
          <MenuRoot>
            <MenuTrigger asChild>
              <button className="wf-select ui-state ui-focus" type="button">
                {brand?.brand ?? '选择品牌'}
                <Icon decorative name="expand" size="xs" />
              </button>
            </MenuTrigger>
            <MenuSurface align="start" side="top">
              <MenuRadioGroup
                onValueChange={(name) => {
                  const picked = brands.find((item) => item.brand === name)
                  if (picked !== undefined) onChange(withBrand(item, values, picked))
                }}
                value={brand?.brand ?? ''}
              >
                {brands.map((item) => (
                  <MenuRadioItem key={item.brand} value={item.brand}>
                    {item.brand}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        </div>
      ) : null}
      {item.variables.length === 0 ? (
        <p className="wf-pop-note">这个组件没有可调的项</p>
      ) : (
        item.variables.map((variable) => (
          <VariableField
            accents={accents}
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
  /** 品牌强调色，颜色项的候选 */
  accents: readonly string[]
  onChange: (value: VariableValue) => void
}

function VariableField({ variable, value, accents, onChange }: FieldProps) {
  const id = useId()
  const label = (
    <label htmlFor={id} title={variable.label}>
      {variable.label}
    </label>
  )
  const hint =
    variable.brand === undefined ? null : <span className="wf-field-hint">默认取自品牌模板</span>
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
      const colors = [...new Set([current, ...accents])].slice(0, 6)
      input = (
        <span className="wf-swatches" role="group">
          {colors.map((color) => (
            <button
              aria-label={accents.includes(color) ? `${color}（品牌强调色）` : color}
              aria-pressed={color === current}
              className="wf-swatch ui-focus"
              key={color}
              onClick={() => onChange(color)}
              style={{ '--wf-swatch': color } as CSSProperties}
              type="button"
            />
          ))}
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
      {hint}
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
