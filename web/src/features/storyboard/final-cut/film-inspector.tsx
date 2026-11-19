import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { BlockedReason } from '../components/blocked-reason'
import type { PeaksState } from '../editing/media-analysis'
import { sourceTrimmed, trimBounds, trimmed, type SourceLength, type Timing } from './clip-edit'
import type { ComponentCatalog, VariableValue } from './composition/catalog'
import { CaptionTextField, type CaptionTextChange } from './captions-tab'
import { CAPTION_COLOR, captionFontSize, captionFontSizeRange } from './composition/captions'
import {
  isDetachedAudio,
  isDubClip,
  isMediaClip,
  type Canvas,
  type CaptionClip,
  type FilmClip,
} from './composition/film'
import type { LocaleBindings } from './composition/locale-text'
import {
  ColorField,
  ContentFields,
  ContentTitle,
  Dropdown,
  HEX_COLOR,
  type TextLocale,
} from './content-fields'
import { Keys, Tool } from './editor-toolbar'
import { SliderControl } from './inspector-controls'
import { ITEM_KIND_LABEL } from './items'
import type { ShownLocale } from './locales'
import type { KeyframeStates } from './material-media'
import { MediaMix, RatePicker } from './media-mix'
import { SmartMixSection } from './smart-mix-section'
import type { AttributeChanges } from './original-sound'
import {
  mergeBlocked,
  offsetText,
  resyncPlan,
  SOUND_ACTION_LOOK,
  soundActionFor,
  type SoundAction,
  type SoundControls,
  type SoundPair,
} from './sound-pair'
import { SourceTrim } from './source-trim'
import type { SmartMix } from './use-smart-mix'

type Values = Readonly<Record<string, VariableValue>>

type CaptionStyleChange = (
  id: string,
  changes: Partial<Pick<CaptionClip, 'font' | 'color' | 'fontSize'>>,
) => void

type Props = {
  /** 时间线上选中的片段。 */
  selected: readonly FilmClip[]
  /** final-cut 里所有的片段：改时间时按它们算落在哪。 */
  clips: readonly FilmClip[]
  catalog: ComponentCatalog
  /** 画面尺寸：字幕的默认字号和能设的范围按它算。 */
  canvas: Canvas
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
  /** 显示着的语言：字幕的「内容」改的是这种语言的字。 */
  locale: ShownLocale
  /** 把字幕 `id` 在一种语言里的字改成 `text`，算一步撤销。 */
  onCaptionText: CaptionTextChange
  /** 改字幕 `id` 的字体、字色、字号（null 是回到默认），所有语言共用，算一步撤销。 */
  onCaptionStyle: CaptionStyleChange
  /** 组件或块的片段的文字字段分语言（「内容与样式」用），`bindings` 是各片段随语言的字段。 */
  texts: Omit<TextLocale, 'locale' | 'bindings'> & {
    bindings: ReadonlyMap<string, LocaleBindings>
  }
  /** 分离音频、合并回视频、联动、对齐口型、选中另一段。 */
  soundControls: SoundControls
  /** 焦点进出「属性」里输数值的框：在里面时 Esc 归输入框，放弃刚输入的。 */
  onTextEditing: (editing: boolean) => void
  /** 选中的是一个有声片段时它的「智能调音」；别的时候是 undefined。 */
  smartMix: SmartMix | undefined
  /** 点「内容与样式」标题右边的语言小块：打开「字幕」页签。 */
  onOpenCaptions: () => void
}

/** 片段的种类；配音片段（含旁白）写「AI 配音」，组件或块的片段按条目在组件库里的种类写，「其他」片段不写。 */
const kindLabel = (clip: FilmClip, catalog: ComponentCatalog): string | undefined => {
  if (clip.kind === 'video') return '视频'
  if (isDubClip(clip)) return 'AI 配音'
  if (clip.kind === 'audio') return clip.syncOrigin === null ? '音频' : '分离原声'
  if (clip.kind === 'caption') return '字幕'
  if (clip.kind === 'other') return undefined
  const kind = catalog.items.find((item) => item.name === clip.item)?.kind
  return kind === undefined ? undefined : ITEM_KIND_LABEL[kind]
}

function KindLabel({ clip, catalog }: { clip: FilmClip; catalog: ComponentCatalog }) {
  const label = kindLabel(clip, catalog)
  return label === undefined ? null : <span className="wf-inspector-kind">{label}</span>
}

type EmblemTone = 'dark' | 'music' | 'original' | 'dub' | 'caption'

/** 头部左边的图标方块：图标和底色按片段的种类，和导航、轨道头的图标一致。 */
const emblemOf = (
  clip: FilmClip,
  catalog: ComponentCatalog,
): { icon: IconName; tone: EmblemTone } => {
  switch (clip.kind) {
    case 'video':
      return { icon: 'final-cut-shots', tone: 'dark' }
    case 'audio':
      if (isDubClip(clip)) return { icon: 'final-cut-narration', tone: 'dub' }
      return clip.syncOrigin === null
        ? { icon: 'final-cut-music', tone: 'music' }
        : { icon: 'final-cut-voice', tone: 'original' }
    case 'caption':
      return { icon: 'final-cut-captions', tone: 'caption' }
    case 'host': {
      const kind = catalog.items.find((item) => item.name === clip.item)?.kind
      if (kind === 'component') return { icon: 'final-cut-overlays', tone: 'dark' }
      if (kind === 'block') return { icon: 'final-cut-scenes', tone: 'dark' }
      return { icon: 'layers', tone: 'dark' }
    }
    case 'other':
      return { icon: 'layers', tone: 'dark' }
  }
}

function Emblem({ icon, tone }: { icon: IconName; tone: EmblemTone }) {
  return (
    <span aria-hidden="true" className={cn('wf-emblem', `is-${tone}`)}>
      <Icon decorative name={icon} size="md" />
    </span>
  )
}

const seconds = (ms: number) => (ms / 1000).toFixed(2)

const NO_PEAKS: PeaksState = { kind: 'loading' }
const NO_BINDINGS: LocaleBindings = {}

/**
 * 侧栏「属性」页签的内容：选中一个片段时显示它的名字、种类和可以改的几张卡片；没选中、选中多个时各有一块说明。
 */
export function FilmInspector({ selected, ...rest }: Props) {
  const [only] = selected
  // 倍速浮层挂在这里：浮层里按的键和「属性」里别的控件一样不当快捷键
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  return (
    // data-inspector：编辑器按它认出「属性」里的控件，那里按的键不当快捷键
    <div className="wf-inspector" data-inspector ref={setRoot}>
      {only === undefined ? (
        <div className="wf-inspector-empty">
          <span aria-hidden="true" className="wf-inspector-empty-icon">
            <Icon decorative name="final-cut-properties" size="md" />
          </span>
          <p>选中时间线上的片段后，可在此调整</p>
        </div>
      ) : selected.length > 1 ? (
        <>
          <div className="wf-inspector-head">
            <Emblem icon="layers" tone="dark" />
            <h3 className="wf-inspector-name">已选中 {selected.length} 个片段</h3>
          </div>
          <div className="wf-inspector-body">
            <div className="wf-card wf-prop-card">
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
          </div>
        </>
      ) : (
        <ClipInspector clip={only} key={only.id} popupContainer={root} {...rest} />
      )}
    </div>
  )
}

/**
 * 选中一个片段：头部是种类图标、名字、种类和时长（字幕写起止），右边隐藏、删除，视频片段还有「分离音频」，分离出来的
 * 原声有「合并回视频」；字幕没有隐藏（只能在行头上整行隐藏）。下面一张卡一件事。视频片段、音频片段是「原片截取」
 * 和「声音与节奏」，组件或块的片段是「显示时长」和「内容与样式」，字幕是「显示时长」和「内容与样式」，「其他」片段
 * 只有「显示时长」。分离过原声的视频片段把「声音与节奏」换成「画面变速」和原声去处的一张，分离出来的原声最上面多
 * 一张同步卡。有声片段最下面是「智能调音」。
 */
function ClipInspector({
  clip,
  clips,
  catalog,
  canvas,
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
  locale,
  onCaptionText,
  onCaptionStyle,
  texts,
  soundControls,
  onTextEditing,
  smartMix,
  onOpenCaptions,
  popupContainer,
}: Omit<Props, 'selected'> & { clip: FilmClip; popupContainer: HTMLElement | null }) {
  const fonts = Object.keys(catalog.fonts).toSorted()
  const sound = clip.kind === 'audio'
  const hideLabel = sound ? (clip.hidden ? '取消静音' : '静音') : clip.hidden ? '显示' : '隐藏'
  const hideIcon = sound
    ? clip.hidden
      ? 'final-cut-sound-off'
      : 'final-cut-sound-on'
    : clip.hidden
      ? 'final-cut-hidden'
      : 'final-cut-visible'
  const action = soundActionFor([clip], clips, silentSource)
  const pair = action.kind === 'merge' ? action.pair : undefined
  return (
    <>
      <header className="wf-inspector-head">
        <Emblem {...emblemOf(clip, catalog)} />
        <div className="wf-inspector-id">
          <h3 className="wf-inspector-name">{clip.label}</h3>
          <p className="wf-inspector-sub">
            <KindLabel catalog={catalog} clip={clip} />
            <span className="wf-inspector-duration">
              {clip.kind === 'caption'
                ? `${seconds(clip.start)} – ${seconds(clip.start + clip.duration)}s`
                : `${seconds(clip.duration)}s`}
            </span>
          </p>
        </div>
        <span className="wf-inspector-actions">
          {action.kind === 'detach' || (action.kind === 'merge' && clip.kind === 'audio') ? (
            <SoundButton action={action} controls={soundControls} />
          ) : null}
          {clip.kind === 'caption' ? null : (
            <Tool
              icon={hideIcon}
              label={hideLabel}
              onClick={() => onHide(clip.id, !clip.hidden)}
              tip={hideLabel}
            />
          )}
          <Tool
            className="is-danger"
            icon="final-cut-delete"
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
            {pair !== undefined && clip.kind === 'audio' ? (
              <SyncCard clips={clips} controls={soundControls} pair={pair} />
            ) : null}
            <SourceTrim
              clip={clip}
              clips={clips}
              keyframe={keyframes.get(clip.src)}
              name={sourceName(clip.src) ?? clip.label}
              onGesture={onGesture}
              onRetime={(timings) => {
                const next = timings.get(clip.id)
                onRetime(next === undefined ? timings : sourceTrimmed(clip, next, clips, sourceMs))
              }}
              peaks={audioPeaks.get(clip.src) ?? NO_PEAKS}
              sourceMs={sourceMs(clip)}
            />
            {pair !== undefined && clip.kind === 'video' ? (
              <>
                <section className="wf-card wf-prop-card">
                  <div className="wf-prop-title-row">
                    <h4 className="wf-prop-title">画面变速</h4>
                    <span className="wf-prop-title-end">
                      <LinkSwitch controls={soundControls} label="与分离原声联动" pair={pair} />
                      <RatePicker
                        container={popupContainer}
                        onChange={(changes) => onAttributes(clip.id, changes)}
                        onEditing={onTextEditing}
                        rate={clip.playbackRate}
                      />
                    </span>
                  </div>
                </section>
                <DetachedCard clips={clips} controls={soundControls} pair={pair} />
              </>
            ) : (
              <MediaMix
                clip={clip}
                onChange={(changes) => onAttributes(clip.id, changes)}
                onEditing={onTextEditing}
                // 分离出来的原声：右上是「静音此段」，和头部的静音按钮是同一个隐藏标记
                onMute={isDetachedAudio(clip) ? (muted) => onHide(clip.id, muted) : undefined}
                popupContainer={popupContainer}
                silent={clip.kind === 'video' && silentSource(clip.src)}
              />
            )}
            {smartMix === undefined ? null : (
              <SmartMixSection mix={smartMix} onEditing={onTextEditing} />
            )}
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
                fonts={fonts}
                onEditing={onTextEditing}
                onLocale={onOpenCaptions}
                onValues={onValues}
                texts={{ ...texts, locale, bindings: texts.bindings.get(clip.id) ?? NO_BINDINGS }}
                variables={catalog.items.find((item) => item.name === clip.item)?.variables ?? []}
              />
            ) : clip.kind === 'caption' ? (
              <CaptionContent
                canvas={canvas}
                clip={clip}
                fonts={fonts}
                locale={locale}
                onEditing={onTextEditing}
                onLocale={onOpenCaptions}
                onStyle={onCaptionStyle}
                onText={onCaptionText}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

/**
 * 字幕的「内容与样式」：这句的字（和「字幕」页签里那条同一个文字框，改的是显示着的语言的字），这句的字体（组件库里
 * 的字体，「默认」是字幕的默认字体）、字号和字色。字体、字号、字色所有语言共用，改了各算一步撤销。
 */
function CaptionContent({
  clip,
  canvas,
  fonts,
  locale,
  onLocale,
  onText,
  onStyle,
  onEditing,
}: {
  clip: CaptionClip
  canvas: Canvas
  fonts: readonly string[]
  locale: ShownLocale
  onLocale: () => void
  onText: CaptionTextChange
  onStyle: CaptionStyleChange
  onEditing: (editing: boolean) => void
}) {
  const textId = useId()
  const fontId = useId()
  const colorId = useId()
  return (
    <section className="wf-card wf-prop-card">
      <ContentTitle locale={locale.code} onLocale={onLocale} />
      <div className="wf-prop-field is-stacked">
        <label className="wf-prop-label" htmlFor={textId}>
          内容
        </label>
        <CaptionTextField
          caption={clip}
          className="wf-field wf-prop-textarea"
          id={textId}
          key={locale.code}
          locale={locale}
          onText={onText}
        />
      </div>
      <div className="wf-prop-field">
        <label className="wf-prop-label" htmlFor={fontId}>
          字体
        </label>
        <Dropdown
          id={fontId}
          label="字体"
          onChange={(font) => onStyle(clip.id, { font: font === '' ? null : font })}
          options={[
            { value: '', label: '默认' },
            ...fonts.map((font) => ({ value: font, label: font })),
          ]}
          // 组件库里没有的字体名和没设一样显示「默认」
          value={clip.font !== null && fonts.includes(clip.font) ? clip.font : ''}
        />
      </div>
      <CaptionFontSize
        canvas={canvas}
        onChange={(fontSize) => onStyle(clip.id, { fontSize })}
        onEditing={onEditing}
        size={clip.fontSize}
      />
      <div className="wf-prop-field">
        <label className="wf-prop-label" htmlFor={colorId}>
          颜色
        </label>
        <ColorField
          complete={(value) => HEX_COLOR.test(value)}
          current={clip.color ?? CAPTION_COLOR}
          id={colorId}
          label="颜色"
          onChange={(color) => onStyle(clip.id, { color })}
        />
      </div>
    </section>
  )
}

const pixelsText = (size: number) => `${size} px`

/**
 * 「字号」滑杆：从默认字号的 0.5 倍到 2 倍，默认处画一道刻度，双击回到默认；没设时显示默认字号。
 * 输入的数超出范围时收进范围。写成默认字号就是回到默认（null）。
 */
function CaptionFontSize({
  canvas,
  size,
  onChange,
  onEditing,
}: {
  canvas: Canvas
  /** 这句设的字号；没设时是 null。 */
  size: number | null
  onChange: (size: number | null) => void
  onEditing: (editing: boolean) => void
}) {
  const fallback = captionFontSize(canvas)
  const { min, max } = captionFontSizeRange(canvas)
  const current = size ?? fallback
  const write = (next: number) => {
    const clamped = Math.min(max, Math.max(min, Math.round(next)))
    onChange(clamped === fallback ? null : clamped)
  }
  return (
    <SliderControl
      format={pixelsText}
      label="字号"
      mark={fallback}
      max={max}
      min={min}
      onCommit={write}
      onDoubleClick={() => onChange(null)}
      onEditing={onEditing}
      onText={(text) => {
        const typed = Number(text.replace(/px$/i, '').trim())
        if (text === '' || !Number.isFinite(typed)) return false
        write(typed)
        return true
      }}
      position={current}
      text={pixelsText(current)}
    />
  )
}

/** 带字的小按钮；`blocked` 时置灰、仍能聚焦，点了说明原因。`tone` 是要先做的那一步（深色实底）。 */
function PropAction({
  blocked,
  tone,
  onClick,
  children,
}: {
  blocked?: string | undefined
  tone?: 'soft'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <BlockedReason reason={blocked}>
      <button
        aria-disabled={blocked === undefined ? undefined : true}
        className={cn('wf-chip-btn ui-state ui-focus', tone === 'soft' && 'is-soft')}
        onClick={() => {
          if (blocked === undefined) onClick()
        }}
        type="button"
      >
        {children}
      </button>
    </BlockedReason>
  )
}

/** 头部的「分离音频」（视频片段）或「合并回视频」（分离出来的原声）。 */
function SoundButton({
  action,
  controls,
}: {
  action: Extract<SoundAction, { kind: 'detach' | 'merge' }>
  controls: SoundControls
}) {
  return (
    <PropAction blocked={action.blocked} onClick={() => controls.run(action)}>
      <Icon decorative name={SOUND_ACTION_LOOK[action.kind].icon} size="sm" />
      {SOUND_ACTION_LOOK[action.kind].label}
    </PropAction>
  )
}

/** 一对的联动开关和它的名字。 */
function LinkSwitch({
  label,
  pair,
  controls,
}: {
  label: string
  pair: SoundPair
  controls: SoundControls
}) {
  const id = useId()
  return (
    <span className="wf-prop-switch">
      <label htmlFor={id}>{label}</label>
      <Switch
        checked={pair.linked}
        id={id}
        onCheckedChange={(linked) => controls.link(pair, linked)}
      />
    </span>
  )
}

/** 对齐口型的按钮：错开时才有；对不了时置灰说明原因。 */
function ResyncAction({
  pair,
  clips,
  controls,
  children,
}: {
  pair: SoundPair
  clips: readonly FilmClip[]
  controls: SoundControls
  children: ReactNode
}) {
  if (pair.offsetMs === 0) return null
  const plan = resyncPlan(pair, clips)
  return (
    <PropAction
      blocked={'refusal' in plan ? plan.refusal : undefined}
      onClick={() => controls.resync(pair)}
      tone="soft"
    >
      {children}
    </PropAction>
  )
}

/** 一对现在同步没有：口型同步、错开多少、倍速不同。 */
const syncText = (offsetMs: number | null, unit: string) =>
  offsetMs === null
    ? '倍速不同'
    : offsetMs === 0
      ? '口型同步'
      : `错开 ${offsetText(offsetMs, unit)}`

/** 同步状态：前面一个小圆点，同步时主色、错开时提示色。 */
function SyncStatus({ pair, children }: { pair: SoundPair; children: ReactNode }) {
  return (
    <span
      className={cn('wf-sound-status', pair.offsetMs !== 0 && 'is-warning')}
      data-testid="sync-status"
    >
      <i aria-hidden="true" className="wf-sound-dot" />
      {children}
    </span>
  )
}

/**
 * 分离过原声的视频片段：原声去了「原声」行，同步状态，「定位分离原声」、错开时「对齐口型」、「合并」。
 */
function DetachedCard({
  pair,
  clips,
  controls,
}: {
  pair: SoundPair
  clips: readonly FilmClip[]
  controls: SoundControls
}) {
  const blocked = mergeBlocked(pair)
  return (
    <section className="wf-card wf-prop-card">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title">原声已分离至「原声」行</h4>
        <SyncStatus pair={pair}>{syncText(pair.offsetMs, 's')}</SyncStatus>
      </div>
      <div className="wf-sound-actions">
        <PropAction onClick={() => controls.locate(pair.audio.id)}>定位分离原声</PropAction>
        <ResyncAction clips={clips} controls={controls} pair={pair}>
          对齐口型
        </ResyncAction>
        <PropAction
          blocked={blocked}
          onClick={() => controls.run({ kind: 'merge', pair, blocked })}
        >
          合并
        </PropAction>
      </div>
    </section>
  )
}

/**
 * 分离出来的原声最上面的同步卡：同步时主色浅底、错开时提示色浅底。上面一行是和画面同步没有、联动开关，下面是错开时
 * 「对齐画面」和「定位画面」（分两行：右栏窄时错开多少也不会被省略掉）。
 */
function SyncCard({
  pair,
  clips,
  controls,
}: {
  pair: SoundPair
  clips: readonly FilmClip[]
  controls: SoundControls
}) {
  return (
    <div className={cn('wf-sync-card', pair.offsetMs !== 0 && 'is-warning')}>
      <div className="wf-prop-title-row">
        <SyncStatus pair={pair}>与画面{syncText(pair.offsetMs, ' 秒')}</SyncStatus>
        <span className="wf-prop-title-end">
          <LinkSwitch controls={controls} label="联动" pair={pair} />
        </span>
      </div>
      <div className="wf-sound-actions">
        <ResyncAction clips={clips} controls={controls} pair={pair}>
          对齐画面
        </ResyncAction>
        <PropAction onClick={() => controls.locate(pair.video.id)}>定位画面</PropAction>
      </div>
    </div>
  )
}

// 「显示时长」的「−」「+」一次改多少
const DURATION_STEP_MS = 500

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
 * 「显示时长」：标题在左，右边一条「−」、秒数框、「+」。加减一次 0.5 秒；框里回车或失焦提交，Esc 放弃，不是数字时
 * 显示回原来的值。改的是结尾，按裁结尾的规则收住：不压到同一行后面的片段，不短于最短长度。
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
    <section className="wf-card wf-prop-card">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title is-icon">
          <Icon decorative name="final-cut-duration" size="sm" />
          <label htmlFor={id}>显示时长</label>
        </h4>
        <span className="wf-field wf-stepper">
          <button
            aria-label="缩短 0.5 秒"
            className="wf-stepper-step ui-state ui-focus"
            disabled={end <= bounds.min}
            onClick={() => lengthTo(clip.duration - DURATION_STEP_MS)}
            type="button"
          >
            −
          </button>
          <span className="wf-stepper-value">
            <Input
              autoComplete="off"
              className="wf-stepper-input"
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
              value={draft ?? seconds(clip.duration)}
            />
            <span aria-hidden="true">s</span>
          </span>
          <button
            aria-label="延长 0.5 秒"
            className="wf-stepper-step ui-state ui-focus"
            disabled={end >= bounds.max}
            onClick={() => lengthTo(clip.duration + DURATION_STEP_MS)}
            type="button"
          >
            +
          </button>
        </span>
      </div>
    </section>
  )
}
