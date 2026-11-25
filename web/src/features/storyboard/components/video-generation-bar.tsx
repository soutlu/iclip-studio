import { useId, useRef } from 'react'
import { Icon } from '@/shared/icons'
import { ASPECT_RATIOS } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { SubmitButton, type SubmitPhase } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  DRAFT_LABEL,
  DRAFT_QUALITY,
  MODELS_PENDING_TEXT,
  VIDEO_RESOLUTIONS,
  type DraftSupport,
  type VideoGenerationOptions,
  type VideoModelsStatus,
  type VideoQuality,
} from '../video-generation-options'
import {
  generationStatusOf,
  type GenerationBlocker,
  type GenerationStatusLine,
} from '../generation-blocker'
import { orderVideoModels, supportsAspectRatio, videoModelShortName } from '../video-model-support'
import { AspectGlyph } from './aspect-glyph'
import { BlockedReason } from './blocked-reason'
import { GenerationPicker, type GenerationPickerOption } from './generation-picker'
import { useHorizontalWheel } from './use-horizontal-wheel'
import { useScrollFade } from './use-scroll-fade'

type AspectControl = {
  value: string
  disabled: boolean
  onChange: (aspectRatio: string) => void
  description: string
}

type VideoModels = { items: readonly string[]; status: VideoModelsStatus; draft: DraftSupport }

type VideoGenerationBarProps = {
  shotIndex: number
  models: VideoModels
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
  aspect: AspectControl
  blocker: GenerationBlocker | undefined
  notice: string | undefined
  phase: SubmitPhase
  onGenerate: () => void
}

export function VideoGenerationBar({
  aspect,
  blocker,
  models,
  notice,
  onChange,
  onGenerate,
  phase,
  shotIndex,
  value,
}: VideoGenerationBarProps) {
  const paramsRef = useRef<HTMLDivElement | null>(null)
  const { fade } = useScrollFade(paramsRef)
  useHorizontalWheel(paramsRef)
  const statusId = useId()
  const hiddenReasonId = useId()
  const { hiddenReason, line: status } = generationStatusOf(blocker, notice)

  return (
    <div aria-label="出片工具栏" className="storyboard-bar" role="group">
      {status === undefined ? null : <BarStatusLine id={statusId} status={status} />}
      {hiddenReason === undefined ? null : (
        <span className="sr-only" id={hiddenReasonId}>
          {hiddenReason}
        </span>
      )}
      <div className="storyboard-bar-row">
        <div
          className="storyboard-bar-params storyboard-scroll-fade"
          data-fade={fade}
          ref={paramsRef}
        >
          <AspectPicker aspect={aspect} model={value.model} />
          <span aria-hidden className="storyboard-bar-divider" />
          <ModelPicker
            aspectRatio={aspect.value}
            models={models}
            onChange={(model) => onChange({ ...value, model })}
            value={value.model}
          />
          <QualityPicker
            draft={models.draft}
            onChange={(quality) => onChange({ ...value, quality })}
            value={value.quality}
          />
          <TooltipRoot>
            <TooltipTrigger asChild>
              <button
                aria-label="生成音频"
                aria-pressed={value.generateAudio}
                className="storyboard-bar-control storyboard-bar-audio ui-state ui-focus"
                onClick={() => onChange({ ...value, generateAudio: !value.generateAudio })}
                type="button"
              >
                <Icon decorative name={value.generateAudio ? 'audio' : 'audio-off'} size="sm" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {value.generateAudio ? '生成音频：开' : '生成音频：关'}
            </TooltipContent>
          </TooltipRoot>
        </div>
        <GenerateButton
          blocked={blocker !== undefined}
          describedBy={
            hiddenReason !== undefined
              ? hiddenReasonId
              : status === undefined
                ? undefined
                : statusId
          }
          onGenerate={onGenerate}
          phase={phase}
          shotIndex={shotIndex}
        />
      </div>
    </div>
  )
}

function BarStatusLine({ id, status }: { id: string; status: GenerationStatusLine }) {
  const error = status.tone === 'error'
  return (
    <p
      className="storyboard-bar-status"
      data-tone={status.tone}
      id={id}
      role={error ? 'alert' : undefined}
      title={status.text}
    >
      <Icon decorative name={error ? 'alert' : 'info'} size="xs" />
      <span className="truncate">{status.text}</span>
    </p>
  )
}

/** 出片栏里的分段槽：一组单选格，不可用的格置灰、点不中，悬停或点击时说明原因。 */
function SegmentedPicker({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string
  label: string
  onChange: (value: string) => void
  options: readonly {
    value: string
    text: string
    title?: string
    blockedReason?: string | undefined
  }[]
  value: string
}) {
  return (
    <ChipGroup
      aria-label={label}
      className={cn('storyboard-bar-well storyboard-bar-segments', className)}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next)
        if (option !== undefined && option.blockedReason === undefined) onChange(option.value)
      }}
      type="single"
      value={value}
      variant="segmented"
    >
      {options.map((option) => {
        const blocked = option.blockedReason !== undefined
        const segment = (
          <FilterChip
            aria-disabled={blocked ? true : undefined}
            className="storyboard-bar-well-item"
            key={option.value}
            title={blocked ? undefined : option.title}
            value={option.value}
            variant="segmented"
          >
            {option.text}
          </FilterChip>
        )
        // Tooltip 触发器会覆盖分段项的 data-state 属性，因此只包裹不可用的格；选中样式按 aria-checked 写。
        return blocked ? (
          <BlockedReason key={option.value} reason={option.blockedReason}>
            {segment}
          </BlockedReason>
        ) : (
          segment
        )
      })}
    </ChipGroup>
  )
}

function ModelPicker({
  aspectRatio,
  models,
  onChange,
  value,
}: {
  aspectRatio: string
  models: VideoModels
  onChange: (model: string) => void
  value: string | undefined
}) {
  if (models.status !== 'ready')
    return (
      <span
        aria-label="视频模型"
        className="storyboard-bar-well storyboard-bar-models-pending"
        role="group"
      >
        <Icon decorative name="video" size="sm" />
        {MODELS_PENDING_TEXT[models.status]}
      </span>
    )
  return (
    <SegmentedPicker
      className="storyboard-bar-models"
      label="视频模型"
      onChange={onChange}
      options={orderVideoModels(models.items).map((model) => ({
        // 已选中的格不置灰：外部带进来的冲突由状态行提示，不替用户改。
        blockedReason:
          model === value || supportsAspectRatio(model, aspectRatio)
            ? undefined
            : `该模型不支持 ${aspectRatio} 画幅`,
        text: videoModelShortName(model),
        title: model,
        value: model,
      }))}
      value={value ?? ''}
    />
  )
}

function QualityPicker({
  draft,
  onChange,
  value,
}: {
  draft: DraftSupport
  onChange: (quality: VideoQuality) => void
  value: VideoQuality
}) {
  const qualities: readonly VideoQuality[] =
    draft === 'off' ? VIDEO_RESOLUTIONS : [...VIDEO_RESOLUTIONS, DRAFT_QUALITY]
  return (
    <SegmentedPicker
      label="分辨率"
      onChange={(next) => {
        const quality = qualities.find((item) => item === next)
        if (quality !== undefined) onChange(quality)
      }}
      options={qualities.map((quality) =>
        quality === DRAFT_QUALITY
          ? {
              blockedReason: draft === 'unsupported' ? '该模型不支持样片' : undefined,
              text: DRAFT_LABEL,
              value: quality,
            }
          : { text: quality, value: quality },
      )}
      value={value}
    />
  )
}

function AspectPicker({ aspect, model }: { aspect: AspectControl; model: string | undefined }) {
  const ratios: string[] = ASPECT_RATIOS.filter((ratio) => supportsAspectRatio(model, ratio))
  if (!ratios.includes(aspect.value)) ratios.unshift(aspect.value)
  const options: GenerationPickerOption[] = ratios.map((ratio) => ({
    leading: <AspectGlyph longSide={14} ratio={ratio} />,
    value: ratio,
  }))
  return (
    <GenerationPicker
      description={aspect.description}
      disabled={aspect.disabled}
      label="画幅"
      leading={<AspectGlyph longSide={13} ratio={aspect.value} />}
      onChange={aspect.onChange}
      options={options}
      text={aspect.value}
      value={aspect.value}
    />
  )
}

function GenerateButton({
  blocked,
  describedBy,
  onGenerate,
  phase,
  shotIndex,
}: {
  blocked: boolean
  describedBy: string | undefined
  onGenerate: () => void
  phase: SubmitPhase
  shotIndex: number
}) {
  const unavailable = phase !== 'idle' || blocked
  return (
    <SubmitButton
      aria-describedby={describedBy}
      aria-disabled={unavailable ? true : undefined}
      className="storyboard-bar-generate shrink-0 rounded-full aria-disabled:active:scale-100"
      label={`生成第 ${shotIndex} 组`}
      leadingIcon="video"
      onClick={() => {
        if (!unavailable) onGenerate()
      }}
      phase={phase}
      size="md"
    />
  )
}
