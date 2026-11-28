import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { ColorPicker } from '@/shared/ui/color-picker'
import { Input } from '@/shared/ui/field'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { Switch } from '@/shared/ui/switch'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  FollowToggle,
  HostTextField,
  type FollowChange,
  type ItemTextChange,
} from './component-texts'
import type { CatalogVariable, VariableValue } from './composition/catalog'
import type { HostClip } from './composition/film'
import type { LocaleBindings } from './composition/locale-text'
import { SliderControl } from './inspector-controls'
import { languageName, type Language, type ShownLocale } from './locales'
import { PropRow, PropSection } from './ui/prop-layout'

type Values = Readonly<Record<string, VariableValue>>

// 照参照的工作台：改可填项停下 300 毫秒再写进 final-cut
const COMMIT_DELAY_MS = 300

export const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** 文字字段分语言要用的：显示着的语言、哪些字段随语言、工程里加没加语言，改字和切换「固定 / 随语言」。 */
export type TextLocale = {
  locale: ShownLocale
  bindings: LocaleBindings
  /** 工程里加了语言：这时文字字段右边才有「固定 / 随语言」。 */
  multilingual: boolean
  onText: ItemTextChange
  onFollow: FollowChange
}

/**
 * 文字那一组小标题右边的小块：写着显示着的语言，点它打开「字幕」页签（在那里切换、添加语言）。元素、模板片段的
 * 「内容与样式」和字幕的「内容」共用。
 */
export function LocaleChip({ locale, onLocale }: { locale: Language; onLocale: () => void }) {
  const name = languageName(locale)
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <button
          aria-label={`显示的语言：${name}`}
          className="wf-prop-locale ui-state ui-focus"
          onClick={onLocale}
          type="button"
        >
          {name}
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        在「字幕」中切换
      </TooltipContent>
    </TooltipRoot>
  )
}

/**
 * 「内容与样式」：条目的可填项，一项一行。改了先留在这里，停下 300 毫秒再整串写进片段；
 * 几项一起改时合成一次写。焦点离开这一段、换选中的片段时把没写的立刻写进去。滑杆、取色板拖动中只动控件自己，
 * 松手才算改了。其它语言下文字字段换成这种语言的文字框（见 `HostTextField`），单独写进去。小标题右边是
 * `LocaleChip`。
 */
export function ContentFields({
  clip,
  variables,
  fonts,
  onValues,
  onEditing,
  texts,
  onLocale,
}: {
  clip: HostClip
  variables: readonly CatalogVariable[]
  fonts: readonly string[]
  onValues: (id: string, values: Values) => void
  onEditing: (editing: boolean) => void
  texts: TextLocale
  /** 点标题右边的语言小块。 */
  onLocale: () => void
}) {
  const [pending, setPending] = useState<Values>({})
  const pendingRef = useRef<Values>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ id: clip.id, values: clip.values, onValues })
  useLayoutEffect(() => {
    latestRef.current = { id: clip.id, values: clip.values, onValues }
  })

  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    const patch = pendingRef.current
    if (Object.keys(patch).length === 0) return
    pendingRef.current = {}
    setPending({})
    const latest = latestRef.current
    latest.onValues(latest.id, { ...latest.values, ...patch })
  }, [])
  useEffect(() => flush, [flush])

  // 输入法还在拼字时不计时：拼音没上屏就写进片段，会多存一次、预览多刷一次
  const composingRef = useRef(false)
  const schedule = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = composingRef.current ? null : setTimeout(flush, COMMIT_DELAY_MS)
  }
  const change = (id: string, value: VariableValue) => {
    pendingRef.current = { ...pendingRef.current, [id]: value }
    setPending(pendingRef.current)
    schedule()
  }
  const compose = (composing: boolean) => {
    composingRef.current = composing
    schedule()
  }

  return (
    <PropSection
      end={<LocaleChip locale={texts.locale.code} onLocale={onLocale} />}
      title="内容与样式"
    >
      {variables.length === 0 ? (
        <p className="wf-inspector-note">暂无可填项</p>
      ) : (
        <div
          className="contents"
          // 焦点从这里的菜单、取色板回到下拉、色块上时不算离开
          onBlur={(event) => {
            const next = event.relatedTarget
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) flush()
          }}
          onCompositionEnd={() => compose(false)}
          onCompositionStart={() => compose(true)}
        >
          {variables.map((variable) =>
            variable.type === 'string' ? (
              <TextRow
                clip={clip}
                current={String(
                  pending[variable.id] ?? clip.values[variable.id] ?? variable.default,
                )}
                key={variable.id}
                onChange={(value) => change(variable.id, value)}
                texts={texts}
                variable={variable}
              />
            ) : (
              <VariableRow
                current={pending[variable.id] ?? clip.values[variable.id] ?? variable.default}
                fonts={fonts}
                key={variable.id}
                onChange={(value) => change(variable.id, value)}
                onEditing={onEditing}
                variable={variable}
              />
            ),
          )}
        </div>
      )}
    </PropSection>
  )
}

type ControlProps = {
  id: string
  variable: CatalogVariable
  current: VariableValue
  fonts: readonly string[]
  onChange: (value: VariableValue) => void
  onEditing: (editing: boolean) => void
}

/**
 * 文字可填项：名字一行（加了语言时右边是「固定 / 随语言」），下面原文下是输入框，和别的可填项一起写；其它语言下
 * 换成这种语言的文字框。
 */
function TextRow({
  clip,
  variable,
  current,
  onChange,
  texts,
}: {
  clip: HostClip
  variable: CatalogVariable
  current: string
  onChange: (value: string) => void
  texts: TextLocale
}) {
  const id = useId()
  const bound = texts.bindings[variable.id]
  return (
    <PropRow
      end={
        texts.multilingual ? (
          <FollowToggle
            follows={bound !== undefined}
            label={variable.label}
            onToggle={(follow) => texts.onFollow(clip.id, variable.id, follow)}
          />
        ) : null
      }
      htmlFor={id}
      label={variable.label}
      stacked
    >
      {texts.locale.values === null ? (
        <Input
          autoComplete="off"
          className="wf-field wf-prop-input"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={current}
        />
      ) : (
        <HostTextField
          className="wf-field wf-prop-input"
          clip={clip}
          field={variable}
          id={id}
          key={texts.locale.code}
          locale={texts.locale}
          onText={texts.onText}
          variable={bound}
        />
      )}
    </PropRow>
  )
}

/** 一项可填项：有上下限的数字是一条滑杆（名字在它上面），别的是名字在左、控件在右的一行。 */
function VariableRow(props: Omit<ControlProps, 'id'>) {
  const id = useId()
  const { variable, current, onChange, onEditing } = props
  if (variable.type === 'number' && variable.min !== undefined && variable.max !== undefined)
    return (
      <NumberSlider
        current={current}
        max={variable.max}
        min={variable.min}
        onChange={onChange}
        onEditing={onEditing}
        variable={variable}
      />
    )
  return (
    <PropRow htmlFor={id} label={variable.label}>
      <VariableControl id={id} {...props} />
    </PropRow>
  )
}

function VariableControl({ id, variable, current, fonts, onChange }: ControlProps) {
  switch (variable.type) {
    case 'boolean':
      return <Switch checked={current === true} id={id} onCheckedChange={onChange} />
    case 'enum':
      return (
        <Dropdown
          id={id}
          label={variable.label}
          onChange={onChange}
          options={variable.options ?? []}
          value={String(current)}
        />
      )
    case 'font':
      return (
        <Dropdown
          id={id}
          label={variable.label}
          onChange={onChange}
          options={[
            { value: '', label: '默认' },
            ...fonts.map((font) => ({ value: font, label: font })),
          ]}
          // 组件库里没有的字体名写不进样式，和没填一样显示「默认」
          value={typeof current === 'string' && fonts.includes(current) ? current : ''}
        />
      )
    case 'color':
      return (
        <ColorField current={String(current)} id={id} label={variable.label} onChange={onChange} />
      )
    case 'number':
      // 有上下限的数字是滑杆，由 VariableRow 管
      return <NumberField current={current} id={id} onChange={onChange} variable={variable} />
    case 'image':
      return <span className="wf-inspector-note">暂不支持在此修改图片</span>
    case 'string':
      // 文字可填项由 TextRow 管
      return null
  }
}

/** 下拉：占满控件那一栏的凹槽，现在的值在左、箭头在右，点开是全站的单选菜单。 */
export function Dropdown({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const shown = options.find((option) => option.value === value)?.label ?? value
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label={`${label}：${shown}`}
          className="wf-field wf-prop-select ui-state ui-focus"
          id={id}
          type="button"
        >
          <span className="wf-prop-select-text">{shown}</span>
          <Icon decorative name="final-cut-expand" size="xs" />
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="wf-menu min-w-(--radix-dropdown-menu-trigger-width)">
        <MenuRadioGroup onValueChange={onChange} value={value}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}

/**
 * 颜色：一条凹槽，左边是现在颜色的小色块（点它打开取色板），后面是能直接输入的十六进制。
 * 取色板拖动中只动这里的色块和文字，松手才算改了。给了 `complete` 时输入框里只有写完整的值才算改了，
 * 没写完的留在框里，失焦时显示回现在的取值。
 */
export function ColorField({
  id,
  label,
  current,
  onChange,
  complete,
}: {
  id: string
  label: string
  current: string
  onChange: (value: string) => void
  complete?: (value: string) => boolean
}) {
  // 拖动中的颜色，连同开始拖时的取值：取值被撤销、输入改掉以后不再用它
  const [dragged, setDragged] = useState<{ from: string; to: string } | null>(null)
  // 还没写完整的输入，连同开始输入时的取值
  const [typed, setTyped] = useState<{ from: string; text: string } | null>(null)
  const shown = dragged !== null && dragged.from === current ? dragged.to : current
  // 文字框里还没写完整时取色板先从黑色开始，照参照的工作台
  // design-allow -- 取色板的值只能是十六进制写法，没法引用颜色变量
  const color = HEX_COLOR.test(shown) ? shown : '#000000'
  return (
    <span className="wf-field">
      <ColorPicker
        onChange={(to) => setDragged({ from: current, to })}
        onCommit={(hex) => {
          setDragged(null)
          onChange(hex)
        }}
        value={color}
      >
        <button
          aria-label={`${label}取色`}
          className="wf-prop-swatch ui-focus"
          style={{ backgroundColor: color }}
          type="button"
        />
      </ColorPicker>
      <input
        autoComplete="off"
        className="wf-prop-hex"
        id={id}
        onBlur={() => setTyped(null)}
        onChange={(event) => {
          const text = event.target.value
          if (complete === undefined) {
            onChange(text)
            return
          }
          setTyped({ from: current, text })
          if (complete(text)) onChange(text)
        }}
        spellCheck={false}
        value={typed !== null && typed.from === current ? typed.text : shown}
      />
    </span>
  )
}

const numberOf = (current: VariableValue) =>
  typeof current === 'number' ? current : Number(current) || 0

/** 有上下限的数字：滑杆加数值，点数值可以直接输入，超出时收进上下限。 */
function NumberSlider({
  variable,
  min,
  max,
  current,
  onChange,
  onEditing,
}: {
  variable: CatalogVariable
  min: number
  max: number
  current: VariableValue
  onChange: (value: VariableValue) => void
  onEditing: (editing: boolean) => void
}) {
  const value = numberOf(current)
  const { step, unit } = variable
  const text = (number: number) => (unit === undefined ? String(number) : `${number} ${unit}`)
  return (
    <SliderControl
      format={text}
      label={variable.label}
      max={max}
      min={min}
      onCommit={onChange}
      onEditing={onEditing}
      onText={(typed) => {
        const number = Number(unit === undefined ? typed : typed.replace(unit, '').trim())
        if (typed === '' || !Number.isFinite(number)) return false
        onChange(Math.min(max, Math.max(min, number)))
        return true
      }}
      position={value}
      step={step ?? 1}
      text={text(value)}
    />
  )
}

/** 没有上下限的数字：数字框，后面写单位；框里清空或不是数字时先不提交。 */
function NumberField({
  id,
  variable,
  current,
  onChange,
}: {
  id: string
  variable: CatalogVariable
  current: VariableValue
  onChange: (value: VariableValue) => void
}) {
  const value = numberOf(current)
  // 框里正在输入的字，连同当时的取值；取值被撤销改掉以后框里换成新的取值
  const [draft, setDraft] = useState<{ text: string; value: number } | null>(null)
  const { step, unit } = variable
  return (
    <span className="wf-prop-number">
      <Input
        className="wf-field wf-prop-input"
        id={id}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          const typed = event.target.value.trim()
          const valid = typed !== '' && Number.isFinite(Number(typed))
          setDraft({ text: event.target.value, value: valid ? Number(typed) : value })
          if (valid) onChange(Number(typed))
        }}
        step={step}
        type="number"
        value={draft !== null && draft.value === value ? draft.text : String(value)}
      />
      {unit === undefined ? null : <span className="wf-prop-unit">{unit}</span>}
    </span>
  )
}
