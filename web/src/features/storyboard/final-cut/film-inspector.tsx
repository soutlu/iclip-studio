import type { ReactNode } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { Icon, type IconName } from '@/shared/icons'
import type { PeaksState } from '../editing/media-analysis'
import { sourceTrimmed, type SourceLength, type Timing } from './clip-edit'
import type { ComponentCatalog, VariableValue } from './composition/catalog'
import type { CaptionStyle } from './composition/captions'
import {
  isDetachedAudio,
  isDubClip,
  isMediaClip,
  type Canvas,
  type FilmClip,
  type MediaClip,
} from './composition/film'
import type { LocaleBindings } from './composition/locale-text'
import { CaptionContent, CaptionStyleRows, type CaptionStyleChange } from './caption-props'
import type { CaptionTextChange } from './captions-tab'
import { ContentFields, type TextLocale } from './content-fields'
import { DubRows, RedubTool, type PickDubVoice } from './dub-props'
import { DurationStepper } from './duration-stepper'
import { Keys, Tool } from './editor-toolbar'
import { hostKindOf, ITEM_KIND_LABEL } from './items'
import type { ShownLocale } from './locales'
import type { KeyframeStates } from './material-media'
import { MediaMix, OriginalSoundSwitch, RateSlider, VolumeSlider } from './media-mix'
import type { AttributeChanges } from './original-sound'
import { DuckSwitch, SmartMixSection } from './smart-mix-section'
import { SOUND_ACTION_LOOK, soundActionFor, type SoundControls } from './sound-pair'
import { DetachedSections, SyncRows } from './sound-sync'
import { SourceTrim } from './source-trim'
import { PropRow, PropSection } from './ui/prop-layout'
import type { SmartMix } from './use-smart-mix'
import type { VoiceControl } from './voice-choices'

type Values = Readonly<Record<string, VariableValue>>

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
  /** 隐藏或显示片段 `id`（音频片段就是静音）：分离出来的原声的「静音此段」用它。 */
  onHide: (id: string, hidden: boolean) => void
  /** 删除当前选中片段（等效快捷键 Delete）。 */
  onRemove: () => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 「原片截取」拖拽起止通知：拖拽期间 Esc 交由其取消手势，暂不触发全局快捷键。 */
  onGesture: (active: boolean) => void
  /** 整体替换元素或模板片段 `id` 的可填项取值。 */
  onValues: (id: string, values: Values) => void
  /** 更新片段 `id` 的属性集合（传入 `null` 表示移除属性），记为一步撤销。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 当前展示语言：字幕「内容」输入框编辑该语言对应文本。 */
  locale: ShownLocale
  /** 修改字幕 `id` 在指定语言下的文本，记为一步撤销。 */
  onCaptionText: CaptionTextChange
  /** 字幕样式：没开「单独设置」的句子用它（没设的项是 `null`，用默认规则）。 */
  captionStyle: CaptionStyle
  /** 修改字幕 `id` 单独设置的字体、字色或字号，所有语言共用并记为一步撤销。 */
  onCaptionStyle: CaptionStyleChange
  /** 修改字幕样式（`null` 表示去掉这一项、回到默认规则），所有语言共用并记为一步撤销。 */
  onCaptionTrackStyle: (changes: Partial<CaptionStyle>) => void
  /** 打开或关闭字幕 `id` 的「单独设置」，记为一步撤销。 */
  onCaptionOwnStyle: (id: string, own: boolean) => void
  /** 元素或模板片段的多语言文字配置（供「内容与样式」使用），`bindings` 记录各片段跟随语言的字段映射。 */
  texts: Omit<TextLocale, 'locale' | 'bindings'> & {
    bindings: ReadonlyMap<string, LocaleBindings>
  }
  /** 音画分离、合并、联动、口型对齐与定位控制。 */
  soundControls: SoundControls
  /** 「属性」内数值输入框焦点状态变更：输入态下 Esc 交由输入框放弃当前草稿。 */
  onTextEditing: (editing: boolean) => void
  /** 选中单个有声片段时的「智能调音」状态与操作；其余情况为 `undefined`。 */
  smartMix: SmartMix | undefined
  /** 点「内容与样式」（字幕是「内容」）小标题右边的语言小块时切换至「字幕」页签。 */
  onOpenCaptions: () => void
  /** 显示着的语言的配音（见 `useVoiceControl`）：配音片段的音色、倍数、过期和「重新合成」从这里读。 */
  voice?: VoiceControl | undefined
  /** 资料库里的音色，配音片段的音色名和封面用；还没读到时是 undefined。 */
  voices?: readonly ReferenceAudio[] | undefined
  /** 点配音片段的「音色」一行；不给时那一行不能点。 */
  onPickVoice?: PickDubVoice | undefined
}

/** 片段在「属性」标题行上的样子：图标（导航同款双色，填充按 `tone` 着色）、读屏名（标题已经写了类别时不给）和标题。 */
type Sign = { icon: IconName; tone: string; kind: string | undefined; title: string }

/** 片段的标题行样子：视频、分离原声、配乐、元素 / 模板写名字，字幕、配音写类别。 */
const signOf = (clip: FilmClip, catalog: ComponentCatalog): Sign => {
  switch (clip.kind) {
    case 'video':
      return { icon: 'final-cut-shots', tone: 'slate', kind: '视频', title: clip.label }
    case 'audio':
      if (isDubClip(clip))
        return { icon: 'final-cut-voice', tone: 'umber', kind: undefined, title: '配音片段' }
      return clip.syncOrigin === null
        ? { icon: 'final-cut-music', tone: 'teal', kind: '音频', title: clip.label }
        : { icon: 'final-cut-voice', tone: 'slate', kind: '分离原声', title: clip.label }
    case 'caption':
      return { icon: 'final-cut-captions', tone: 'teal', kind: undefined, title: '字幕' }
    case 'host': {
      const kind = hostKindOf(clip, catalog)
      if (kind === undefined)
        return { icon: 'layers', tone: 'neutral', kind: undefined, title: clip.label }
      const look =
        kind === 'component'
          ? ({ icon: 'final-cut-overlays', tone: 'copper' } as const)
          : ({ icon: 'final-cut-scenes', tone: 'ochre' } as const)
      return { ...look, kind: ITEM_KIND_LABEL[kind], title: clip.label }
    }
    case 'other':
      return { icon: 'layers', tone: 'neutral', kind: undefined, title: clip.label }
  }
}

/** 片段种类的短名（多选清单里写在名字后面）：配音写「AI 配音」，「其他」类型不写。 */
const kindLabel = (clip: FilmClip, catalog: ComponentCatalog): string | undefined => {
  if (isDubClip(clip)) return 'AI 配音'
  if (clip.kind === 'caption') return '字幕'
  return signOf(clip, catalog).kind
}

const seconds = (ms: number) => (ms / 1000).toFixed(2)

const NO_PEAKS: PeaksState = { kind: 'loading' }
const NO_BINDINGS: LocaleBindings = {}

/**
 * 标题行：左边片段种类的图标、加粗的标题、起止时间（等宽浅色），右边一个快捷动作（`action`）。
 */
function InspectorHead({
  sign,
  range,
  action,
}: {
  sign: Sign
  range?: string
  action?: ReactNode
}) {
  return (
    <header className="wf-inspector-head">
      <span
        aria-hidden={sign.kind === undefined ? true : undefined}
        aria-label={sign.kind}
        className="wf-inspector-sign"
        data-tone={sign.tone}
        role={sign.kind === undefined ? undefined : 'img'}
      >
        <Icon decorative name={sign.icon} size="md" />
      </span>
      <h3 className="wf-inspector-name">{sign.title}</h3>
      {range === undefined ? null : <span className="wf-inspector-range">{range}</span>}
      {action === undefined ? null : <span className="wf-inspector-action">{action}</span>}
    </header>
  )
}

/**
 * 侧栏「属性」页签：单选片段时展示标题行和平铺的各行设置；多选时展示选中清单提示；未选中时展示引导空态。
 */
export function FilmInspector({ selected, ...rest }: Props) {
  const [only] = selected
  return (
    // data-inspector 供编辑器键盘分派识别「属性」区域控件，避免误触发快捷键
    <div className="wf-inspector" data-inspector>
      {only === undefined ? (
        <div className="wf-inspector-empty">
          <span aria-hidden="true" className="wf-inspector-empty-icon">
            <Icon decorative name="final-cut-cursor-select" size="md" />
          </span>
          <p>点选时间线上的片段，可调整画面、声音或字幕</p>
        </div>
      ) : selected.length > 1 ? (
        <>
          <InspectorHead
            sign={{
              icon: 'layers',
              tone: 'neutral',
              kind: undefined,
              title: `已选中 ${selected.length} 个片段`,
            }}
          />
          <div className="wf-inspector-body">
            <ul aria-label="选中的片段" className="wf-inspector-multi-list">
              {selected.map((clip) => {
                const kind = kindLabel(clip, rest.catalog)
                return (
                  <li key={clip.id}>
                    <span className="wf-inspector-multi-name">{clip.label}</span>
                    {kind === undefined ? null : (
                      <span className="wf-inspector-multi-kind">{kind}</span>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="wf-inspector-note">已选中多个片段，无法在此修改；请只选中一个片段</p>
          </div>
        </>
      ) : (
        <ClipInspector clip={only} key={only.id} {...rest} />
      )}
    </div>
  )
}

/**
 * 单片段：标题行的快捷动作按种类——视频「分离音频」、分离出来的原声「合并」、配音「重新合成」、字幕与元素 / 模板 /
 * 其他「删除」、配乐没有。取消选中按 Esc 或点时间线空白处，隐藏、静音在时间线片段的右键菜单里。
 */
function ClipInspector({
  clip,
  catalog,
  clips,
  silentSource,
  soundControls,
  onRemove,
  voice,
  ...rest
}: Omit<Props, 'selected'> & { clip: FilmClip }) {
  const sign = signOf(clip, catalog)
  const action = soundActionFor([clip], clips, silentSource)
  const remove = (
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
  )
  const quick = isMediaClip(clip) ? (
    isDubClip(clip) ? (
      <RedubTool clip={clip} control={voice} />
    ) : action.kind === 'detach' || (action.kind === 'merge' && clip.kind === 'audio') ? (
      <Tool
        blocked={action.blocked}
        icon={SOUND_ACTION_LOOK[action.kind].icon}
        label={SOUND_ACTION_LOOK[action.kind].label}
        onClick={() => soundControls.run(action)}
        tip={SOUND_ACTION_LOOK[action.kind].label}
      />
    ) : undefined
  ) : (
    remove
  )
  return (
    <>
      <InspectorHead
        action={quick}
        range={`${seconds(clip.start)} – ${seconds(clip.start + clip.duration)}s`}
        sign={sign}
      />
      <div className="wf-inspector-body">
        {isMediaClip(clip) ? (
          <MediaBody
            catalog={catalog}
            clip={clip}
            clips={clips}
            silentSource={silentSource}
            soundControls={soundControls}
            voice={voice}
            {...rest}
          />
        ) : (
          <>
            <PropSection>
              <DurationStepper
                clip={clip}
                clips={clips}
                onEditing={rest.onTextEditing}
                onRetime={rest.onRetime}
                sourceMs={rest.sourceMs}
              />
            </PropSection>
            {clip.kind === 'host' ? (
              <ContentFields
                clip={clip}
                fonts={Object.keys(catalog.fonts).toSorted()}
                onEditing={rest.onTextEditing}
                onLocale={rest.onOpenCaptions}
                onValues={rest.onValues}
                texts={{
                  ...rest.texts,
                  locale: rest.locale,
                  bindings: rest.texts.bindings.get(clip.id) ?? NO_BINDINGS,
                }}
                variables={catalog.items.find((item) => item.name === clip.item)?.variables ?? []}
              />
            ) : clip.kind === 'caption' ? (
              <>
                <CaptionContent
                  clip={clip}
                  locale={rest.locale}
                  onLocale={rest.onOpenCaptions}
                  onText={rest.onCaptionText}
                />
                <CaptionStyleRows
                  canvas={rest.canvas}
                  catalog={catalog}
                  clip={clip}
                  fonts={Object.keys(catalog.fonts).toSorted()}
                  onEditing={rest.onTextEditing}
                  onOwn={rest.onCaptionOwnStyle}
                  onStyle={rest.onCaptionStyle}
                  onTrackStyle={rest.onCaptionTrackStyle}
                  style={rest.captionStyle}
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

/**
 * 音视频片段：最上面是这类片段最常改的几行（视频「片段时长」「保留原声」、配音「音色」「槽位倍速」、配乐「音量」
 * 「自动避让」、分离原声的同步状态），下面依次是「原片截取」「声音与节奏」（分离过原声的视频是「画面变速」和原声
 * 去处）和「智能调音」。
 */
function MediaBody({
  clip,
  clips,
  silentSource,
  soundControls,
  voice,
  voices,
  onPickVoice,
  smartMix,
  onAttributes,
  onTextEditing,
  onHide,
  onRetime,
  onGesture,
  sourceMs,
  sourceName,
  keyframes,
  audioPeaks,
}: Omit<Props, 'selected' | 'onRemove'> & { clip: MediaClip }) {
  const action = soundActionFor([clip], clips, silentSource)
  const pair = action.kind === 'merge' ? action.pair : undefined
  const music = clip.kind === 'audio' && !isDubClip(clip) && clip.syncOrigin === null
  const change = (changes: AttributeChanges) => onAttributes(clip.id, changes)
  return (
    <>
      <PropSection>
        {clip.kind === 'video' ? (
          <>
            <PropRow label="片段时长">
              <span className="wf-field is-static">{seconds(clip.duration)}s</span>
            </PropRow>
            {pair === undefined ? (
              <OriginalSoundSwitch clip={clip} onChange={change} silent={silentSource(clip.src)} />
            ) : null}
          </>
        ) : isDubClip(clip) ? (
          <DubRows clip={clip} control={voice} onPick={onPickVoice} voices={voices} />
        ) : music ? (
          <>
            <VolumeSlider clip={clip} onChange={change} onEditing={onTextEditing} />
            {smartMix === undefined ? null : (
              <DuckSwitch mix={smartMix} onEditing={onTextEditing} />
            )}
          </>
        ) : pair === undefined ? null : (
          <SyncRows clips={clips} controls={soundControls} pair={pair} />
        )}
      </PropSection>
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
        <DetachedSections
          clips={clips}
          controls={soundControls}
          pair={pair}
          rate={<RateSlider onChange={change} onEditing={onTextEditing} rate={clip.playbackRate} />}
        />
      ) : (
        <MediaMix
          clip={clip}
          onChange={change}
          onEditing={onTextEditing}
          // 分离原声的「静音此段」就是片段的隐藏标记，和右键菜单里的静音是同一个
          onMute={isDetachedAudio(clip) ? (muted) => onHide(clip.id, muted) : undefined}
          withVolume={!music}
        />
      )}
      {smartMix === undefined ? null : (
        <SmartMixSection mix={smartMix} onEditing={onTextEditing} withDuck={!music} />
      )}
    </>
  )
}
