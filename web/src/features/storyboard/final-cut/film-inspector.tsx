import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { Input } from '@/shared/ui/field'
import type { PeaksState } from '../editing/media-analysis'
import { trimBounds, trimmed, type SourceLength, type Timing } from './clip-edit'
import type { ComponentCatalog, VariableValue } from './composition/catalog'
import { isMediaClip, type FilmClip } from './composition/film'
import { ContentFields } from './content-fields'
import { Keys, Tool } from './editor-toolbar'
import { ITEM_KIND_LABEL } from './items'
import type { KeyframeStates } from './material-media'
import { MediaMix, type AttributeChanges } from './media-mix'
import { SourceTrim } from './source-trim'

type Values = Readonly<Record<string, VariableValue>>

type Props = {
  /** 时间线上选中的片段。 */
  selected: readonly FilmClip[]
  /** final-cut 里所有的片段：改时间时按它们算落在哪。 */
  clips: readonly FilmClip[]
  catalog: ComponentCatalog
  sourceMs: SourceLength
  /** 视频素材的镜头读取状态：「原片截取」在素材总长读到之前写它读到哪了。 */
  keyframes: KeyframeStates
  /** 音频片段素材的波形读取状态。 */
  audioPeaks: ReadonlyMap<string, PeaksState>
  /** 这个地址的素材确认没有声音；有声音、还不知道时是 false。 */
  silentSource: (src: string) => boolean
  /** 这个地址的出片叫什么（镜头组、原作、版本）；不是出片时是 undefined。 */
  sourceName: (src: string) => string | undefined
  onHide: (id: string, hidden: boolean) => void
  /** 删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 「原片截取」开始或结束拖动：拖动中的 Esc 归它（只取消这一次拖动），快捷键先不接。 */
  onGesture: (active: boolean) => void
  /** 把组件或块的片段 `id` 的可填项取值整个换成 `values`。 */
  onValues: (id: string, values: Values) => void
  /** 改片段 `id` 上的几个属性（null 是去掉），算一步撤销。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 焦点进出「属性」里输数值的框：在里面时 Esc 归输入框，放弃刚输入的。 */
  onTextEditing: (editing: boolean) => void
}

/** 片段的种类；组件或块的片段按条目在组件库里的种类写，「其他」片段不写。 */
const kindLabel = (clip: FilmClip, catalog: ComponentCatalog): string | undefined => {
  if (clip.kind === 'video') return '视频'
  if (clip.kind === 'audio') return '音频'
  if (clip.kind === 'other') return undefined
  const kind = catalog.items.find((item) => item.name === clip.item)?.kind
  return kind === undefined ? undefined : ITEM_KIND_LABEL[kind]
}

function KindLabel({ clip, catalog }: { clip: FilmClip; catalog: ComponentCatalog }) {
  const label = kindLabel(clip, catalog)
  return label === undefined ? null : <span className="wf-inspector-kind">{label}</span>
}

const NO_PEAKS: PeaksState = { kind: 'loading' }

/**
 * 侧栏「属性」页签的内容：选中一个片段时显示它的名字、种类和可以改的几段；没选中、选中多个时各有一句说明。
 */
export function FilmInspector({ selected, ...rest }: Props) {
  const [only] = selected
  return (
    // data-inspector：编辑器按它认出「属性」里的控件，那里按的键不当快捷键
    <div className="wf-inspector" data-inspector>
      {only === undefined ? (
        <p className="wf-inspector-empty">选中时间线上的片段后，可在此调整</p>
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
                <KindLabel catalog={rest.catalog} clip={clip} />
              </li>
            ))}
          </ul>
          <p className="wf-inspector-note">已选中多个片段，无法在此修改；请只选中一个片段</p>
        </div>
      ) : (
        <ClipInspector clip={only} key={only.id} {...rest} />
      )}
    </div>
  )
}

/**
 * 选中一个片段：头部是名字、种类、时长和隐藏、删除；下面平铺几段。视频片段、音频片段是「原片截取」和
 * 「音量与变速」，组件或块的片段是「显示时长」和「内容与样式」，「其他」片段只有「显示时长」。
 */
function ClipInspector({
  clip,
  clips,
  catalog,
  sourceMs,
  keyframes,
  audioPeaks,
  silentSource,
  sourceName,
  onHide,
  onRemove,
  onRetime,
  onGesture,
  onValues,
  onAttributes,
  onTextEditing,
}: Omit<Props, 'selected'> & { clip: FilmClip }) {
  const sound = clip.kind === 'audio'
  const hideLabel = sound ? (clip.hidden ? '取消静音' : '静音') : clip.hidden ? '显示' : '隐藏'
  return (
    <>
      <header className="wf-inspector-head">
        <h3 className="wf-inspector-name">{clip.label}</h3>
        <KindLabel catalog={catalog} clip={clip} />
        <span className="wf-inspector-duration">{(clip.duration / 1000).toFixed(2)}s</span>
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
        {isMediaClip(clip) ? (
          <>
            <SourceTrim
              clip={clip}
              clips={clips}
              keyframe={keyframes.get(clip.src)}
              name={sourceName(clip.src) ?? clip.label}
              onGesture={onGesture}
              onRetime={onRetime}
              peaks={audioPeaks.get(clip.src) ?? NO_PEAKS}
              sourceMs={sourceMs(clip)}
            />
            <MediaMix
              clip={clip}
              onChange={(changes) => onAttributes(clip.id, changes)}
              onEditing={onTextEditing}
              silent={clip.kind === 'video' && silentSource(clip.src)}
            />
          </>
        ) : (
          <>
            <DisplayDuration
              clip={clip}
              clips={clips}
              onEditing={onTextEditing}
              onRetime={onRetime}
              sourceMs={sourceMs}
            />
            {clip.kind === 'host' ? (
              <ContentFields
                clip={clip}
                fonts={Object.keys(catalog.fonts).toSorted()}
                onEditing={onTextEditing}
                onValues={onValues}
                variables={catalog.items.find((item) => item.name === clip.item)?.variables ?? []}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

// 「显示时长」的「−」「+」一次改多少
const DURATION_STEP_MS = 500

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
 * 「显示时长」：「−」、秒数框、「+」。加减一次 0.5 秒；框里回车或失焦提交，Esc 放弃，不是数字时显示回原来的值。
 * 改的是结尾，按裁结尾的规则收住：不压到同一行后面的片段，不短于最短长度。
 */
function DisplayDuration({
  clip,
  clips,
  sourceMs,
  onRetime,
  onEditing,
}: {
  clip: FilmClip
  clips: readonly FilmClip[]
  sourceMs: SourceLength
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  onEditing: (editing: boolean) => void
}) {
  const id = useId()
  const bounds = trimBounds(clip, 'end', clips, sourceMs(clip))
  const lengthTo = (ms: number) => {
    const timing = trimmed(clip, 'end', clip.start + ms, bounds)
    if (timing.duration !== clip.duration) onRetime(new Map([[clip.id, timing]]))
  }
  const [draft, setDraft] = useState<string | null>(null)
  // 按 Esc 时先放弃再失焦，失焦的处理读这里，不等重新渲染
  const draftRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }
  // 框还聚焦着就被卸掉（final-cut 被换成别处存的一版）时收不到失焦，这里补一下
  useEffect(() => () => onEditing(false), [onEditing])
  const end = clip.start + clip.duration
  return (
    <section className="wf-prop-section is-inline">
      <h4 className="wf-prop-title">
        <label htmlFor={id}>显示时长</label>
      </h4>
      <span className="wf-prop-stepper">
        <button
          aria-label="缩短 0.5 秒"
          className="wf-prop-step ui-state ui-focus"
          disabled={end <= bounds.min}
          onClick={() => lengthTo(clip.duration - DURATION_STEP_MS)}
          type="button"
        >
          −
        </button>
        <span className="wf-prop-seconds">
          <Input
            autoComplete="off"
            className="wf-prop-seconds-input"
            id={id}
            inputMode="decimal"
            onBlur={() => {
              onEditing(false)
              const parsed = draftRef.current === null ? null : parseSeconds(draftRef.current)
              edit(null)
              if (parsed !== null) lengthTo(parsed)
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
            value={draft ?? formatSeconds(clip.duration)}
          />
          <span aria-hidden="true">秒</span>
        </span>
        <button
          aria-label="延长 0.5 秒"
          className="wf-prop-step ui-state ui-focus"
          disabled={end >= bounds.max}
          onClick={() => lengthTo(clip.duration + DURATION_STEP_MS)}
          type="button"
        >
          +
        </button>
      </span>
    </section>
  )
}
