import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { RATE_RANGE } from '@hyperframes/core/audio-automation'
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  audioGainToFaderPosition,
  audioGainToText,
  formatAudioGain,
} from '@hyperframes/core/audio-gain'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Input, Select } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { groupShift, trimBounds, trimmed, type SourceLength, type Timing } from './clip-edit'
import type { CatalogVariable, ComponentCatalog, VariableValue } from './composition/catalog'
import {
  isMediaClip,
  type ClipAttribute,
  type ClipKind,
  type FilmClip,
  type HostClip,
  type MediaClip,
} from './composition/film'
import { Keys, Tool } from './editor-toolbar'
import {
  parseGainInput,
  parseRateInput,
  parseSecondsInput,
} from './vendor/hyperframes-studio/components/editor/audioInspectorInput'
import { formatNumericValue } from './vendor/hyperframes-studio/components/editor/propertyPanelHelpers'
import {
  fromUnit,
  toUnit,
} from './vendor/hyperframes-studio/player/components/automationLaneGeometry'

type Values = Readonly<Record<string, VariableValue>>

type Props = {
  /** 时间线上选中的片段。 */
  selected: readonly FilmClip[]
  /** 成片里所有的片段：改时间时按它们算落在哪。 */
  clips: readonly FilmClip[]
  catalog: ComponentCatalog
  sourceMs: SourceLength
  /** 这个地址的素材确认没有声音；有声音、还不知道时是 false。 */
  silentSource: (src: string) => boolean
  onHide: (id: string, hidden: boolean) => void
  /** 删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
  onRestart: (starts: ReadonlyMap<string, number>) => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 把组件或块的片段 `id` 的可填项取值整个换成 `values`。 */
  onValues: (id: string, values: Values) => void
  /** 改片段 `id` 上的几个属性（null 是去掉），算一步撤销。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 焦点进出「时间」「媒体」里输数值的框：在里面时 Esc 归输入框，放弃刚输入的。 */
  onTextEditing: (editing: boolean) => void
}

type AttributeChanges = Readonly<Partial<Record<ClipAttribute, string | null>>>

const KIND_LABEL: Record<ClipKind, string> = { video: '视频', host: '组件', audio: '音频' }

// 照参照的工作台：改可填项停下 300 毫秒再写进成片
const COMMIT_DELAY_MS = 300

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const SILENT_SOURCE_TEXT = '该素材没有声音，无法取消静音'

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
 * 右侧栏：选中一个片段时显示它的名字、种类和可以改的分组；没选中、选中多个时各有一个说明。
 */
export function FilmInspector({ selected, ...rest }: Props) {
  const [only] = selected
  return (
    // data-inspector：编辑器按它认出右侧栏里的控件，那里按的键不当快捷键
    <aside aria-label="属性" className="wf-inspector" data-inspector>
      {only === undefined ? (
        <div className="wf-inspector-empty">
          <Icon decorative name="select-tool" size="lg" />
          <h3 className="wf-inspector-empty-title">尚未选中片段</h3>
          <p>在时间线上选中片段后可在此修改</p>
        </div>
      ) : selected.length > 1 ? (
        <div className="wf-inspector-multi">
          <div className="wf-inspector-multi-head">
            <Icon decorative name="layers" size="sm" />
            <h3>已选中 {selected.length} 个片段</h3>
          </div>
          <ul aria-label="选中的片段" className="wf-inspector-multi-list">
            {selected.map((clip) => (
              <li key={clip.id}>
                <span className="wf-inspector-multi-name">{clip.label}</span>
                <span className="wf-inspector-kind">{KIND_LABEL[clip.kind]}</span>
              </li>
            ))}
          </ul>
          <p className="wf-inspector-note">已选中多个片段，无法在此修改；请只选中一个片段</p>
        </div>
      ) : (
        <ClipInspector clip={only} key={only.id} {...rest} />
      )}
    </aside>
  )
}

type Group = {
  id: 'content' | 'time' | 'media'
  title: string
  summary: string
  content: ReactNode
}

/** 选中一个片段：头部是名字、种类和隐藏、删除；下面的分组一次只展开一个，收起的在标题旁写摘要。 */
function ClipInspector({
  clip,
  clips,
  catalog,
  sourceMs,
  silentSource,
  onHide,
  onRemove,
  onRestart,
  onRetime,
  onValues,
  onAttributes,
  onTextEditing,
}: Omit<Props, 'selected'> & { clip: FilmClip }) {
  const groups: Group[] = []
  if (clip.kind === 'host') {
    const variables = catalog.items.find((item) => item.name === clip.component)?.variables ?? []
    const text = variables.find((variable) => variable.type === 'string')
    groups.push({
      id: 'content',
      title: '内容',
      summary: text === undefined ? '' : String(clip.values[text.id] ?? text.default),
      content: (
        <ContentFields
          clip={clip}
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
    summary: `${formatSeconds(clip.start)} – ${formatSeconds(clip.start + clip.duration)} 秒`,
    content: (
      <TimeFields
        clip={clip}
        clips={clips}
        onEditing={onTextEditing}
        onRestart={onRestart}
        onRetime={onRetime}
        sourceMs={sourceMs}
      />
    ),
  })
  if (isMediaClip(clip))
    groups.push({
      id: 'media',
      title: '媒体',
      summary: '',
      content: (
        <MediaFields
          clip={clip}
          onChange={(changes) => onAttributes(clip.id, changes)}
          onEditing={onTextEditing}
          silent={clip.kind === 'video' && silentSource(clip.src)}
          sourceMs={sourceMs(clip)}
        />
      ),
    })
  // 照参照的工作台：组件或块的片段先展开「内容」，别的片段展开第一个分组；再点展开着的分组就全收起
  const [open, setOpen] = useState<Group['id'] | null>(groups[0]?.id ?? null)
  const sound = clip.kind === 'audio'
  const hideLabel = sound ? (clip.hidden ? '取消静音' : '静音') : clip.hidden ? '显示' : '隐藏'
  const baseId = useId()

  return (
    <>
      <header className="wf-inspector-head">
        <h3 className="wf-inspector-name">{clip.label}</h3>
        <span className="wf-inspector-kind">{KIND_LABEL[clip.kind]}</span>
        <span className="wf-inspector-actions">
          <Tool
            icon={
              sound ? (clip.hidden ? 'audio-off' : 'audio') : clip.hidden ? 'excluded' : 'included'
            }
            label={hideLabel}
            onClick={() => onHide(clip.id, !clip.hidden)}
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
  clip,
  clips,
  sourceMs,
  onRestart,
  onRetime,
  onEditing,
}: {
  clip: FilmClip
  clips: readonly FilmClip[]
  sourceMs: SourceLength
  onRestart: (starts: ReadonlyMap<string, number>) => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  onEditing: (editing: boolean) => void
}) {
  // 框还聚焦着就被卸掉（成片被换成别处存的一版）时收不到失焦，这里补一下
  useEffect(() => () => onEditing(false), [onEditing])
  const end = clip.start + clip.duration
  const startAt = (ms: number) => {
    const { delta } = groupShift(clip, new Set([clip.id]), clips, ms - clip.start, clip.track)
    if (delta !== 0) onRestart(new Map([[clip.id, clip.start + delta]]))
  }
  const endAt = (ms: number) => {
    const timing = trimmed(clip, 'end', ms, trimBounds(clip, 'end', clips, sourceMs(clip)))
    if (timing.duration !== clip.duration) onRetime(new Map([[clip.id, timing]]))
  }
  return (
    <div className="wf-inspector-time">
      <SecondsField label="开始" ms={clip.start} onCommit={startAt} onEditing={onEditing} />
      <SecondsField label="结束" ms={end} onCommit={endAt} onEditing={onEditing} />
      <SecondsField
        label="时长"
        ms={clip.duration}
        onCommit={(ms) => endAt(clip.start + ms)}
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

// 速度滑杆的格数：照参照的工作台，0.1–10 倍按对数铺满 1000 格，正中是 1 倍
const RATE_STEPS = 1000

const secondsText = (ms: number) => `${formatSeconds(ms)} 秒`

/** 输入框里的秒数（后面的「秒」可带可不带）按参照的工作台读成毫秒；读不出时是 null。 */
const parseSecondsText = (text: string): number | null => {
  const seconds = parseSecondsInput(text.trim().replace(/秒$/, ''))
  return seconds === null ? null : Math.round(seconds * 1000)
}

/** 写进文件的秒数：淡入淡出照参照的工作台留两位小数，0 时去掉。 */
const fadeAttribute = (ms: number) => {
  const rounded = Math.round(ms / 10) * 10
  return rounded > 0 ? String(rounded / 1000) : null
}

/**
 * 「媒体」：文件、增益、速度、起始位置、淡入、淡出，音频片段另有循环，视频片段另有静音。
 * 换算和上下限照参照的工作台；拖滑杆时只动这里，松手（或按一下方向键）才写进成片，一次算一步撤销。
 * 改速度不改片段在成片里的时长，用掉的素材跟着变长或变短。
 */
function MediaFields({
  clip,
  sourceMs,
  silent,
  onChange,
  onEditing,
}: {
  clip: MediaClip
  /** 素材的总长；还不知道时是 undefined。 */
  sourceMs: number | undefined
  /** 视频片段的素材确认没有声音。 */
  silent: boolean
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
}) {
  const { volume, playbackRate, mediaStart, duration, fadeIn, fadeOut } = clip
  // 起始位置最多到「素材长 − 片段长 × 速度」；素材长还不知道时只能往前调，同裁剪
  const mediaStartMax =
    sourceMs === undefined
      ? mediaStart
      : Math.max(0, Math.floor(sourceMs - duration * playbackRate))
  // 照参照的工作台：视频片段静音以后不再有声音可以淡入淡出
  const audible = clip.kind === 'audio' || !clip.muted
  const rateText = (rate: number) => `${formatNumericValue(rate)}x`
  const rateAt = (position: number) => fromUnit(RATE_RANGE, position / RATE_STEPS)
  const setGain = (gain: number) => onChange({ 'data-volume': formatAudioGain(gain) })
  const setRate = (rate: number) => {
    const written = formatNumericValue(rate)
    onChange({ 'data-playback-rate': written === '1' ? null : written })
  }
  const setMediaStart = (ms: number) =>
    onChange({ 'data-media-start': String(Math.min(mediaStartMax, Math.max(0, ms)) / 1000) })
  const fade = (name: 'data-fade-in' | 'data-fade-out', ms: number, other: number) => {
    // 照参照的工作台：一端最多到片段长减去另一端
    const max = Math.max(0, duration - other)
    return (
      <MediaSlider
        format={(position) => secondsText(position * 10)}
        label={name === 'data-fade-in' ? '淡入' : '淡出'}
        max={Math.round(max / 10)}
        min={0}
        onCommit={(position) => onChange({ [name]: fadeAttribute(position * 10) })}
        onEditing={onEditing}
        onText={(text) => {
          const typed = parseSecondsText(text)
          if (typed === null) return false
          onChange({ [name]: fadeAttribute(Math.min(typed, max)) })
          return true
        }}
        position={Math.round(ms / 10)}
        text={secondsText(ms)}
      />
    )
  }
  return (
    <div className="wf-inspector-rows">
      <div className="wf-field">
        <span>文件</span>
        <span className="wf-inspector-static wf-media-file" title={clip.label}>
          {clip.label}
        </span>
      </div>
      <MediaSlider
        centered
        format={(position) => audioGainToText(audioFaderPositionToGain(position))}
        label="增益"
        max={AUDIO_GAIN_FADER_MAX}
        min={AUDIO_GAIN_FADER_MIN}
        onCommit={(position) => setGain(audioFaderPositionToGain(position))}
        onEditing={onEditing}
        onText={(text) => {
          const gain = parseGainInput(text)
          if (gain === null) return false
          setGain(gain)
          return true
        }}
        position={audioGainToFaderPosition(volume)}
        text={audioGainToText(volume)}
      />
      <MediaSlider
        centered
        format={(position) => rateText(rateAt(position))}
        label="速度"
        max={RATE_STEPS}
        min={0}
        onCommit={(position) => setRate(rateAt(position))}
        onEditing={onEditing}
        onText={(text) => {
          const rate = parseRateInput(text)
          if (rate === null) return false
          setRate(rate)
          return true
        }}
        position={Math.round(toUnit(RATE_RANGE, playbackRate) * RATE_STEPS)}
        text={rateText(playbackRate)}
      />
      <MediaSlider
        format={(position) => secondsText(position * 10)}
        label="起始位置"
        max={Math.floor(mediaStartMax / 10)}
        min={0}
        onCommit={(position) => setMediaStart(position * 10)}
        onEditing={onEditing}
        onText={(text) => {
          const typed = parseSecondsText(text)
          if (typed === null) return false
          setMediaStart(typed)
          return true
        }}
        position={Math.round(mediaStart / 10)}
        text={secondsText(mediaStart)}
      />
      {audible ? (
        <>
          {fade('data-fade-in', fadeIn, fadeOut)}
          {fade('data-fade-out', fadeOut, fadeIn)}
        </>
      ) : null}
      {clip.kind === 'audio' ? (
        <MediaSwitch
          checked={clip.loop}
          label="循环"
          onChange={(loop) => onChange({ loop: loop ? 'true' : null })}
        />
      ) : (
        <MediaSwitch
          // 素材没有声音时不让取消静音：标成有声音的视频片段导出必定失败
          blockedReason={silent && clip.muted ? SILENT_SOURCE_TEXT : undefined}
          checked={clip.muted}
          label="静音"
          // 照参照的工作台：静音写 muted、去掉有声音的标记，取消静音反过来，两个不同时写
          onChange={(muted) =>
            onChange(
              muted
                ? { muted: 'true', 'data-has-audio': null }
                : { muted: null, 'data-has-audio': 'true' },
            )
          }
        />
      )}
    </div>
  )
}

function MediaSwitch({
  label,
  checked,
  blockedReason,
  onChange,
}: {
  label: string
  checked: boolean
  /** 不能拨的原因，悬停或聚焦时提示；能拨时不给。 */
  blockedReason?: string | undefined
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="wf-field">
      <label htmlFor={id}>{label}</label>
      <Switch blockedReason={blockedReason} checked={checked} id={id} onCheckedChange={onChange} />
    </div>
  )
}

/**
 * 「媒体」里的一行：名字、滑杆、右边的数值。滑杆按格走（`position` 是格数），拖的时候数值跟着变，
 * 松手才交给 `onCommit`。点数值可以直接输入：回车或失焦交给 `onText`，它返回 false 表示读不出——
 * 回车时框留着、标成不对，失焦时放弃；Esc 放弃。照参照的工作台。
 */
function MediaSlider({
  label,
  min,
  max,
  position,
  text,
  format,
  centered = false,
  onCommit,
  onText,
  onEditing,
}: {
  label: string
  min: number
  max: number
  position: number
  /** 现在的取值怎么显示。 */
  text: string
  /** 拖到 `position` 这一格时怎么显示。 */
  format: (position: number) => string
  /** 正中是不增不减（增益、速度），画一道刻度。 */
  centered?: boolean
  onCommit: (position: number) => void
  onText: (text: string) => boolean
  onEditing: (editing: boolean) => void
}) {
  const id = useId()
  const rangeRef = useRef<HTMLInputElement>(null)
  // 拖到的格数，连同开始拖时的取值：松手停在原处时浏览器不发 change，取值被撤销、输入改掉以后不再用它
  const [dragged, setDragged] = useState<{ from: number; to: number } | null>(null)
  const draft = dragged !== null && dragged.from === position ? dragged.to : null
  const commitRef = useRef(onCommit)
  useLayoutEffect(() => {
    commitRef.current = onCommit
  })
  // 浏览器在松手、按一下方向键时发 change，拖动中只发 input（React 的 onChange 收的是 input）
  useEffect(() => {
    const range = rangeRef.current
    if (range === null) return
    const commit = () => {
      setDragged(null)
      commitRef.current(Number(range.value))
    }
    range.addEventListener('change', commit)
    return () => range.removeEventListener('change', commit)
  }, [])
  const shown = draft === null ? text : format(draft)
  return (
    <div className="wf-field">
      <label htmlFor={id}>{label}</label>
      <span className={cn('wf-media-control', centered && 'is-centered')}>
        <input
          aria-valuetext={shown}
          className="wf-media-range ui-focus"
          id={id}
          max={max}
          min={min}
          onChange={(event) => {
            // change 已经在上面交出去了，这里只跟着拖动
            if (event.nativeEvent.type !== 'change')
              setDragged({ from: position, to: Number(event.target.value) })
          }}
          ref={rangeRef}
          step={1}
          type="range"
          value={draft ?? Math.min(max, Math.max(min, position))}
        />
        <Readout label={label} onEditing={onEditing} onText={onText} text={shown} />
      </span>
    </div>
  )
}

/** 滑杆右边的数值：点一下变成输入框。 */
function Readout({
  label,
  text,
  onText,
  onEditing,
}: {
  label: string
  text: string
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
        className="wf-media-readout ui-state ui-focus"
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
      className="wf-inspector-input wf-media-input"
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

/**
 * 「内容」：组件条目的可填项，一项一行。改了先留在这里，停下 300 毫秒再整串写进片段；
 * 几项一起改时合成一次写。失焦、换选中的片段时把没写的立刻写进去。
 */
function ContentFields({
  clip,
  variables,
  fonts,
  onValues,
}: {
  clip: HostClip
  variables: readonly CatalogVariable[]
  fonts: readonly string[]
  onValues: (id: string, values: Values) => void
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

  if (variables.length === 0) return <p className="wf-inspector-note">暂无可填项</p>
  return (
    <div
      className="wf-inspector-rows"
      onBlur={flush}
      onCompositionEnd={() => compose(false)}
      onCompositionStart={() => compose(true)}
    >
      {variables.map((variable) => (
        <VariableRow
          current={pending[variable.id] ?? clip.values[variable.id] ?? variable.default}
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
      return <span className="wf-inspector-static">暂不支持在此修改图片</span>
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
