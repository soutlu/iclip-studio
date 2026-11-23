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
  /** 时间线上当前选中的片段列表。 */
  selected: readonly FilmClip[]
  /** 工程内的全部片段，用于调整时长时计算邻接边界。 */
  clips: readonly FilmClip[]
  catalog: ComponentCatalog
  /** 画布尺寸，用于计算字幕默认字号与可选字号范围。 */
  canvas: Canvas
  sourceMs: SourceLength
  /** 视频素材关键帧读取状态，「原片截取」在素材总时长就绪前据此展示加载状态。 */
  keyframes: KeyframeStates
  /** 音频片段素材波形读取状态。 */
  audioPeaks: ReadonlyMap<string, PeaksState>
  /** 指定素材地址是否已确认无音轨；有声或尚未检测完成时返回 `false`。 */
  silentSource: (src: string) => boolean
  /** 根据素材地址查询出片显示名（镜头组、原作与版本）；非出片素材返回 `undefined`。 */
  sourceName: (src: string) => string | undefined
  onHide: (id: string, hidden: boolean) => void
  /** 删除当前选中片段（等效快捷键 Delete）。 */
  onRemove: () => void
  /** 取消选中（等效按 Esc 或点击时间线空白处）。 */
  onDeselect: () => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 「原片截取」拖拽起止通知：拖拽期间 Esc 交由其取消手势，暂不触发全局快捷键。 */
  onGesture: (active: boolean) => void
  /** 整体替换组件或场景片段 `id` 的可填项取值。 */
  onValues: (id: string, values: Values) => void
  /** 更新片段 `id` 的属性集合（传入 `null` 表示移除属性），记为一步撤销。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 当前展示语言：字幕「内容」输入框编辑该语言对应文本。 */
  locale: ShownLocale
  /** 修改字幕 `id` 在指定语言下的文本，记为一步撤销。 */
  onCaptionText: CaptionTextChange
  /** 修改字幕 `id` 的字体、字色或字号（`null` 表示恢复默认），所有语言共用并记为一步撤销。 */
  onCaptionStyle: CaptionStyleChange
  /** 组件或场景片段的多语言文字配置（供「内容与样式」使用），`bindings` 记录各片段跟随语言的字段映射。 */
  texts: Omit<TextLocale, 'locale' | 'bindings'> & {
    bindings: ReadonlyMap<string, LocaleBindings>
  }
  /** 音画分离、合并、联动、口型对齐与定位控制。 */
  soundControls: SoundControls
  /** 「属性」内数值输入框焦点状态变更：输入态下 Esc 交由输入框放弃当前草稿。 */
  onTextEditing: (editing: boolean) => void
  /** 选中单个有声片段时的「智能调音」状态与操作；其余情况为 `undefined`。 */
  smartMix: SmartMix | undefined
  /** 点击「内容与样式」标题右侧语言标签时切换至「字幕」页签。 */
  onOpenCaptions: () => void
}

/** 获取片段类型展示名：配音（含旁白）记作「AI 配音」，贴片/场景按组件库分类名展示，「其他」类型不展示。 */
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

/** 属性头部左侧的片段类型徽标配置（图标与底色与侧栏导航及轨道行头保持一致）。 */
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
 * 侧栏「属性」页签：单选片段时展示名称、类型与各属性编辑卡；多选时展示选中清单提示；未选中时展示引导空态。
 */
export function FilmInspector({ selected, ...rest }: Props) {
  const [only] = selected
  // 倍速浮层挂载于此节点内，使浮层按键与「属性」内其余控件一致不触发编辑器快捷键
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  return (
    // data-inspector 供编辑器键盘分派识别「属性」区域控件，避免误触发快捷键
    <div className="wf-inspector" data-inspector ref={setRoot}>
      {only === undefined ? (
        <div className="wf-inspector-empty">
          <span aria-hidden="true" className="wf-inspector-empty-icon">
            <Icon decorative name="final-cut-cursor-select" size="md" />
          </span>
          <p>点选时间线上的片段，可调整画面、声音或字幕</p>
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
 * 单片段属性面板：顶栏包含类型徽标、名称、类型、时长（字幕显示起止时刻）及隐藏/静音、删除、取消选中与音画分离/合并操作
 * （字幕无单句隐藏，需通过轨道行头整行隐藏）。主体按片段类型组合卡片：
 * 音视频展示「原片截取」「声音与节奏」（已分离原声的视频改为「画面变速」与原声去向卡，分离原声顶部额外展示同步卡），
 * 有声片段底部附「智能调音」；贴片、场景与字幕展示「显示时长」与「内容与样式」；「其他」类型仅展示「显示时长」。
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
  onDeselect,
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
          <Tool
            icon="final-cut-close"
            label="取消选中"
            onClick={onDeselect}
            shortcuts="Escape"
            tip={
              <>
                取消选中
                <Keys>Esc</Keys>
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
                // 分离原声右上角的「静音此段」与顶栏静音按钮共享同一隐藏标记
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
 * 字幕「内容与样式」卡片：编辑当前展示语言下的字幕文本（与「字幕」页签共用输入框）以及跨语言共享的字体、字号与字色（各项修改各记一步撤销）。
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
          // 不在组件库可选列表中的字体名按未设置处理，回退展示「默认」
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
 * 「字号」滑杆：范围为默认字号的 0.5–2 倍，默认处标注刻度并支持双击恢复默认；未单独设置时显示默认字号。
 * 超出范围的输入自动钳制；输入值等于默认字号时归置为 `null`（恢复默认）。
 */
function CaptionFontSize({
  canvas,
  size,
  onChange,
  onEditing,
}: {
  canvas: Canvas
  /** 当前句独立设置的字号；未设置时为 `null`。 */
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

/** 属性卡片内嵌操作按钮：`blocked` 非空时置灰但保持可聚焦，点击弹出原因；`tone="soft"` 用于主推荐动作。 */
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

/** 顶栏的「分离音频」（视频片段）或「合并回视频」（分离原声）按钮。 */
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

/** 音画配对联动开关及标签。 */
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

/** 口型对齐按钮：仅在音画错位时呈现；无法对齐时置灰并说明原因。 */
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

/** 格式化音画配对同步状态：口型同步、错开时长或倍速不一致。 */
const syncText = (offsetMs: number | null, unit: string) =>
  offsetMs === null
    ? '倍速不同'
    : offsetMs === 0
      ? '口型同步'
      : `错开 ${offsetText(offsetMs, unit)}`

/** 同步状态指示标签：前缀圆点按同步态与错位态区分语义色。 */
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
 * 已分离原声的视频片段去向卡：说明原声已移至「原声」行并展示同步状态，提供「定位分离原声」「对齐口型」（错位时）及「合并」入口。
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
 * 分离原声顶部的同步状态卡：按同步态与错位态区分浅底色。
 * 分两行排布（首行为同步状态与联动开关，次行为「对齐画面」与「定位画面」），避免右栏较窄时截断错位读数。
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

// 「显示时长」步进按钮单次增减步长（毫秒）
const DURATION_STEP_MS = 500

/** 将输入的秒数文本（允许带「秒」或 `s` 后缀）解析为毫秒并保留两位小数精度；非法输入返回 `null`。 */
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
 * 「显示时长」卡片：右侧提供 0.5 秒步进按钮与秒数输入框（回车或失焦提交，Esc 放弃，非法值还原）。
 * 调整作用于片段右端并遵循右端裁切边界：不侵占同行后续片段，且不短于最短片段时长。
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
  // 按 Esc 时先清空草稿再触发失焦，onBlur 直接读取该 ref，避免等待重新渲染
  const draftRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }
  // 输入框聚焦期间若因外部重载被卸载，不会触发 onBlur，需在卸载清理中复位编辑态
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
