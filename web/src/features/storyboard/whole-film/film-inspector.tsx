import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon } from '@/shared/icons'
import { Input, Select } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { groupShift, trimBounds, trimmed, type SourceLength, type Timing } from './block-edit'
import type { CatalogVariable, ComponentCatalog, VariableValue } from './composition/catalog'
import type { BlockKind, ComponentBlock, FilmBlock } from './composition/film'
import { Keys, Tool } from './editor-toolbar'

type Values = Readonly<Record<string, VariableValue>>

type Props = {
  /** 时间线上选中的块。 */
  selected: readonly FilmBlock[]
  /** 成片里所有的块：改时间时按它们算落在哪。 */
  blocks: readonly FilmBlock[]
  catalog: ComponentCatalog
  sourceMs: SourceLength
  onHide: (id: string, hidden: boolean) => void
  /** 删掉选中的块，和按 Delete 一样。 */
  onRemove: () => void
  onRestart: (starts: ReadonlyMap<string, number>) => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 把组件块 `id` 的可填项取值整个换成 `values`。 */
  onValues: (id: string, values: Values) => void
  /** 焦点进出「时间」里的输入框：在里面时 Esc 归输入框，放弃刚输入的。 */
  onTimeEditing: (editing: boolean) => void
}

const KIND_LABEL: Record<BlockKind, string> = { picture: '视频', component: '组件', audio: '音频' }

// 照参照的工作台：改可填项停下 300 毫秒再写进成片
const COMMIT_DELAY_MS = 300

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const formatSeconds = (ms: number) => (ms / 1000).toFixed(2)

/** 输入框里的秒数（可带「秒」或 s）换成毫秒，按两位小数取整；不是数字时是 null。 */
const parseSeconds = (text: string): number | null => {
  const cleaned = text
    .trim()
    .replace(/\s*(秒|s)$/i, '')
    .trim()
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? Math.round(value * 100) * 10 : null
}

/**
 * 右侧栏：选中一个块时显示它的名字、种类和可以改的分组；没选中、选中多个时各有一个说明。
 */
export function FilmInspector({ selected, ...rest }: Props) {
  const [only] = selected
  return (
    // data-inspector：编辑器按它认出右侧栏里的控件，那里按的键不当快捷键
    <aside aria-label="属性" className="wf-inspector" data-inspector>
      {only === undefined ? (
        <div className="wf-inspector-empty">
          <Icon decorative name="select-tool" size="lg" />
          <h3 className="wf-inspector-empty-title">没有选中</h3>
          <p>在时间线上点一个块，在这里改它。</p>
        </div>
      ) : selected.length > 1 ? (
        <div className="wf-inspector-multi">
          <div className="wf-inspector-multi-head">
            <Icon decorative name="layers" size="sm" />
            <h3>选中了 {selected.length} 个块</h3>
          </div>
          <ul aria-label="选中的块" className="wf-inspector-multi-list">
            {selected.map((block) => (
              <li key={block.id}>
                <span className="wf-inspector-multi-name">{block.label}</span>
                <span className="wf-inspector-kind">{KIND_LABEL[block.kind]}</span>
              </li>
            ))}
          </ul>
          <p className="wf-inspector-note">只选中一个块时，才能在这里改它</p>
        </div>
      ) : (
        <BlockInspector block={only} key={only.id} {...rest} />
      )}
    </aside>
  )
}

type Group = { id: 'content' | 'time'; title: string; summary: string; content: ReactNode }

/** 选中一个块：头部是名字、种类和隐藏、删除；下面的分组一次只展开一个，收起的在标题旁写摘要。 */
function BlockInspector({
  block,
  blocks,
  catalog,
  sourceMs,
  onHide,
  onRemove,
  onRestart,
  onRetime,
  onValues,
  onTimeEditing,
}: Omit<Props, 'selected'> & { block: FilmBlock }) {
  const groups: Group[] = []
  if (block.kind === 'component') {
    const variables = catalog.items.find((item) => item.name === block.component)?.variables ?? []
    const text = variables.find((variable) => variable.type === 'string')
    groups.push({
      id: 'content',
      title: '内容',
      summary: text === undefined ? '' : String(block.values[text.id] ?? text.default),
      content: (
        <ContentFields
          block={block}
          fonts={Object.keys(catalog.fonts).toSorted()}
          onValues={onValues}
          variables={variables}
        />
      ),
    })
  }
  groups.push({
    id: 'time',
    title: '时间',
    summary: `${formatSeconds(block.start)} – ${formatSeconds(block.start + block.duration)} 秒`,
    content: (
      <TimeFields
        block={block}
        blocks={blocks}
        onEditing={onTimeEditing}
        onRestart={onRestart}
        onRetime={onRetime}
        sourceMs={sourceMs}
      />
    ),
  })
  // 照参照的工作台：组件块先展开「内容」，别的块展开第一个分组；再点展开着的分组就全收起
  const [open, setOpen] = useState<Group['id'] | null>(groups[0]?.id ?? null)
  const sound = block.kind === 'audio'
  const hideLabel = sound ? (block.hidden ? '取消静音' : '静音') : block.hidden ? '显示' : '隐藏'
  const baseId = useId()

  return (
    <>
      <header className="wf-inspector-head">
        <h3 className="wf-inspector-name">{block.label}</h3>
        <span className="wf-inspector-kind">{KIND_LABEL[block.kind]}</span>
        <span className="wf-inspector-actions">
          <Tool
            icon={
              sound
                ? block.hidden
                  ? 'audio-off'
                  : 'audio'
                : block.hidden
                  ? 'excluded'
                  : 'included'
            }
            label={hideLabel}
            onClick={() => onHide(block.id, !block.hidden)}
            tip={hideLabel}
          />
          <Tool
            icon="delete"
            label="删除"
            onClick={onRemove}
            shortcuts="Delete"
            tip={
              <>
                删除
                <Keys>Delete</Keys>
              </>
            }
          />
        </span>
      </header>
      <div className="wf-inspector-body">
        {groups.map((group) => {
          const expanded = open === group.id
          const panelId = `${baseId}-${group.id}`
          return (
            <section className="wf-inspector-group" key={group.id}>
              <h4>
                <button
                  aria-controls={expanded ? panelId : undefined}
                  aria-expanded={expanded}
                  className="wf-inspector-group-title ui-state ui-focus"
                  onClick={() => setOpen((current) => (current === group.id ? null : group.id))}
                  type="button"
                >
                  <span>{group.title}</span>
                  {!expanded && group.summary !== '' ? (
                    <>
                      {/* 读屏时标题和摘要之间断开；弹性布局里不占地方 */}{' '}
                      <span className="wf-inspector-summary">{group.summary}</span>
                    </>
                  ) : null}
                  <Icon decorative name={expanded ? 'expand' : 'disclosure'} size="xs" />
                </button>
              </h4>
              {expanded ? (
                <div className="wf-inspector-fields" id={panelId}>
                  {group.content}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </>
  )
}

/**
 * 「时间」：开始、结束、时长三个框。改开始是在本行里挪过去，改结束、时长是裁结尾；
 * 都按拖动时的规则落位，放不下时落到规则允许的最近处。
 */
function TimeFields({
  block,
  blocks,
  sourceMs,
  onRestart,
  onRetime,
  onEditing,
}: {
  block: FilmBlock
  blocks: readonly FilmBlock[]
  sourceMs: SourceLength
  onRestart: (starts: ReadonlyMap<string, number>) => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  onEditing: (editing: boolean) => void
}) {
  // 框还聚焦着就被卸掉（成片被换成别处存的一版）时收不到失焦，这里补一下
  useEffect(() => () => onEditing(false), [onEditing])
  const end = block.start + block.duration
  const startAt = (ms: number) => {
    const { delta } = groupShift(block, new Set([block.id]), blocks, ms - block.start, block.track)
    if (delta !== 0) onRestart(new Map([[block.id, block.start + delta]]))
  }
  const endAt = (ms: number) => {
    const timing = trimmed(block, 'end', ms, trimBounds(block, 'end', blocks, sourceMs(block)))
    if (timing.duration !== block.duration) onRetime(new Map([[block.id, timing]]))
  }
  return (
    <div className="wf-inspector-time">
      <SecondsField label="开始" ms={block.start} onCommit={startAt} onEditing={onEditing} />
      <SecondsField label="结束" ms={end} onCommit={endAt} onEditing={onEditing} />
      <SecondsField
        label="时长"
        ms={block.duration}
        onCommit={(ms) => endAt(block.start + ms)}
        onEditing={onEditing}
      />
    </div>
  )
}

/** 一个秒数框：回车或失焦提交，Esc 放弃；不是数字时不提交，显示回原来的值。 */
function SecondsField({
  label,
  ms,
  onCommit,
  onEditing,
}: {
  label: string
  ms: number
  onCommit: (ms: number) => void
  onEditing: (editing: boolean) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  // 按 Esc 时先放弃再失焦，失焦的处理读这里，不等重新渲染
  const draftRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }
  return (
    <div className="wf-inspector-cell">
      <label htmlFor={id}>{label}</label>
      <span className="wf-inspector-seconds">
        <Input
          autoComplete="off"
          className="wf-inspector-input"
          id={id}
          inputMode="decimal"
          onBlur={() => {
            onEditing(false)
            const parsed = draftRef.current === null ? null : parseSeconds(draftRef.current)
            edit(null)
            if (parsed !== null) onCommit(parsed)
          }}
          onChange={(event) => edit(event.target.value)}
          onFocus={() => onEditing(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            else if (event.key === 'Escape') {
              edit(null)
              event.currentTarget.blur()
            }
          }}
          value={draft ?? formatSeconds(ms)}
        />
        <span aria-hidden="true">秒</span>
      </span>
    </div>
  )
}

/**
 * 「内容」：组件条目的可填项，一项一行。改了先留在这里，停下 300 毫秒再整串写进块；
 * 几项一起改时合成一次写。失焦、换选中的块时把没写的立刻写进去。
 */
function ContentFields({
  block,
  variables,
  fonts,
  onValues,
}: {
  block: ComponentBlock
  variables: readonly CatalogVariable[]
  fonts: readonly string[]
  onValues: (id: string, values: Values) => void
}) {
  const [pending, setPending] = useState<Values>({})
  const pendingRef = useRef<Values>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ id: block.id, values: block.values, onValues })
  useLayoutEffect(() => {
    latestRef.current = { id: block.id, values: block.values, onValues }
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

  const change = (id: string, value: VariableValue) => {
    pendingRef.current = { ...pendingRef.current, [id]: value }
    setPending(pendingRef.current)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(flush, COMMIT_DELAY_MS)
  }

  if (variables.length === 0) return <p className="wf-inspector-note">这个组件没有可以填的内容</p>
  return (
    <div className="wf-inspector-rows" onBlur={flush}>
      {variables.map((variable) => (
        <VariableRow
          current={pending[variable.id] ?? block.values[variable.id] ?? variable.default}
          fonts={fonts}
          key={variable.id}
          onChange={(value) => change(variable.id, value)}
          variable={variable}
        />
      ))}
    </div>
  )
}

/** 一项可填项：按类型用不同的控件，照参照的工作台。 */
function VariableRow({
  variable,
  current,
  fonts,
  onChange,
}: {
  variable: CatalogVariable
  current: VariableValue
  fonts: readonly string[]
  onChange: (value: VariableValue) => void
}) {
  const id = useId()
  return (
    <div className="wf-field">
      <label htmlFor={id} title={variable.label}>
        {variable.label}
      </label>
      <VariableControl
        current={current}
        fonts={fonts}
        id={id}
        onChange={onChange}
        variable={variable}
      />
    </div>
  )
}

function VariableControl({
  id,
  variable,
  current,
  fonts,
  onChange,
}: {
  id: string
  variable: CatalogVariable
  current: VariableValue
  fonts: readonly string[]
  onChange: (value: VariableValue) => void
}) {
  switch (variable.type) {
    case 'boolean':
      return <Switch checked={current === true} id={id} onCheckedChange={onChange} />
    case 'enum':
      return (
        <Dropdown id={id} onChange={onChange} value={String(current)}>
          {(variable.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Dropdown>
      )
    case 'font':
      return (
        <Dropdown
          id={id}
          onChange={onChange}
          // 组件库里没有的字体名写不进样式，和没填一样显示「默认」
          value={typeof current === 'string' && fonts.includes(current) ? current : ''}
        >
          <option value="">默认</option>
          {fonts.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </Dropdown>
      )
    case 'color':
      return (
        <span className="wf-inspector-color">
          <input
            aria-label={`${variable.label}取色`}
            className="wf-color ui-focus"
            onChange={(event) => onChange(event.target.value)}
            type="color"
            // 取色框只认 #rrggbb，文字框里还没写完整时照参照的工作台先给黑色
            // design-allow -- 取色框的值只能是十六进制写法，没法引用颜色变量
            value={HEX_COLOR.test(String(current)) ? String(current) : '#000000'}
          />
          <Input
            autoComplete="off"
            className="wf-inspector-input"
            id={id}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            value={String(current)}
          />
        </span>
      )
    case 'number':
      return <NumberControl current={current} id={id} onChange={onChange} variable={variable} />
    case 'image':
      return <span className="wf-inspector-static">图片暂不支持在这里修改</span>
    case 'string':
      return (
        <Input
          autoComplete="off"
          className="wf-inspector-input"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={String(current)}
        />
      )
  }
}

/** 下拉框：原生下拉，右边的箭头换成和分组标题一样的图标。 */
function Dropdown({
  id,
  value,
  onChange,
  children,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <span className="wf-inspector-select">
      <Select
        className="wf-inspector-input"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </Select>
      <Icon decorative name="expand" size="xs" />
    </span>
  )
}

/** 数字：数字框，有上下限时前面再加滑杆，后面写单位。框里清空或不是数字时先不提交。 */
function NumberControl({
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
  const value = typeof current === 'number' ? current : Number(current) || 0
  // 框里正在输入的字，连同当时的取值；取值被滑杆、撤销改掉以后框里换成新的取值
  const [draft, setDraft] = useState<{ text: string; value: number } | null>(null)
  const { min, max, step, unit } = variable
  return (
    <span className="wf-field-number">
      {min !== undefined && max !== undefined ? (
        <input
          aria-label={variable.label}
          className="wf-inspector-range"
          max={max}
          min={min}
          onChange={(event) => onChange(Number(event.target.value))}
          step={step ?? 1}
          type="range"
          value={value}
        />
      ) : null}
      <Input
        className="wf-inspector-input"
        id={id}
        max={max}
        min={min}
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
      {unit === undefined ? null : <span className="wf-inspector-unit">{unit}</span>}
    </span>
  )
}
