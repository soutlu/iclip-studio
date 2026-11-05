import { useId, useRef } from 'react'
import { Icon } from '@/shared/icons'
import { ASPECT_RATIOS } from '@/shared/lib/aspect-ratio'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  MODELS_PENDING_TEXT,
  VIDEO_RESOLUTIONS,
  type VideoGenerationOptions,
  type VideoModelsStatus,
} from '../video-generation-options'
import {
  generationStatusOf,
  type GenerationBlocker,
  type GenerationStatusLine,
} from '../generation-blocker'
import { supportsAspectRatio } from '../video-model-support'
import { AspectGlyph } from './aspect-glyph'
import { GenerationPicker, type GenerationPickerOption } from './generation-picker'
import { useScrollFade } from './use-scroll-fade'

type AspectControl = {
  value: string
  disabled: boolean
  onChange: (aspectRatio: string) => void
  description: string
}

type VideoGenerationBarProps = {
  shotIndex: number
  models: { items: readonly string[]; status: VideoModelsStatus }
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
  aspect: AspectControl
  blocker: GenerationBlocker | undefined
  notice: string | undefined
  submitting: boolean
  onGenerate: () => void
}

export function VideoGenerationBar({
  aspect,
  blocker,
  models,
  notice,
  onChange,
  onGenerate,
  shotIndex,
  submitting,
  value,
}: VideoGenerationBarProps) {
  const modelLabel =
    value.model ?? (models.status === 'ready' ? '' : MODELS_PENDING_TEXT[models.status])
  const paramsRef = useRef<HTMLDivElement | null>(null)
  const { fade } = useScrollFade(paramsRef)
  const statusId = useId()
  const hiddenReasonId = useId()
  const { hiddenReason, line: status } = generationStatusOf(blocker, notice)

  return (
    <div
      aria-label="出片工具栏"
      className="storyboard-bar rounded-xl border-[0.5px] border-hairline bg-surface-container-lowest shadow-[var(--shadow-2)]"
      role="group"
    >
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
          <AspectPicker
            aspect={aspect}
            errorId={status?.tone === 'error' ? statusId : undefined}
            model={value.model}
          />
          <span aria-hidden className="storyboard-bar-divider" />
          <GenerationPicker
            className="storyboard-bar-model"
            disabled={submitting || models.items.length === 0}
            label="视频模型"
            leading={<Icon decorative name="video" size="sm" />}
            onChange={(model) => onChange({ ...value, model })}
            options={models.items.map((model) => ({ value: model }))}
            text={modelLabel}
            value={value.model ?? ''}
          />
          <ChipGroup
            aria-label="分辨率"
            className="storyboard-bar-segmented"
            disabled={submitting}
            onValueChange={(next) => {
              const resolution = VIDEO_RESOLUTIONS.find((item) => item === next)
              if (resolution !== undefined) onChange({ ...value, resolution })
            }}
            type="single"
            value={value.resolution}
            variant="segmented"
          >
            {VIDEO_RESOLUTIONS.map((resolution) => (
              <FilterChip
                className="storyboard-bar-segment"
                key={resolution}
                value={resolution}
                variant="segmented"
              >
                {resolution}
              </FilterChip>
            ))}
          </ChipGroup>
          <TooltipRoot>
            <TooltipTrigger asChild>
              <button
                aria-label="生成音频"
                aria-pressed={value.generateAudio}
                className="storyboard-bar-control storyboard-bar-audio ui-state ui-focus"
                disabled={submitting}
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
          shotIndex={shotIndex}
          submitting={submitting}
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

function AspectPicker({
  aspect,
  errorId,
  model,
}: {
  aspect: AspectControl
  errorId: string | undefined
  model: string | undefined
}) {
  const unsupported = !supportsAspectRatio(model, aspect.value)
  const leading = unsupported ? (
    <Icon decorative name="alert" size="sm" />
  ) : (
    <AspectGlyph longSide={13} ratio={aspect.value} />
  )
  const options: GenerationPickerOption[] = ASPECT_RATIOS.map((ratio) => {
    const usable = supportsAspectRatio(model, ratio)
    return {
      disabled: !usable,
      hint: usable ? undefined : '不支持',
      leading: <AspectGlyph longSide={14} ratio={ratio} />,
      value: ratio,
    }
  })
  if (!ASPECT_RATIOS.some((ratio) => ratio === aspect.value))
    options.unshift({
      leading: <AspectGlyph longSide={14} ratio={aspect.value} />,
      value: aspect.value,
    })
  return (
    <GenerationPicker
      description={aspect.description}
      disabled={aspect.disabled}
      invalid={unsupported ? { describedBy: errorId } : undefined}
      label="画幅"
      leading={leading}
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
  shotIndex,
  submitting,
}: {
  blocked: boolean
  describedBy: string | undefined
  onGenerate: () => void
  shotIndex: number
  submitting: boolean
}) {
  const unavailable = submitting || blocked
  return (
    <Button
      aria-describedby={describedBy}
      aria-disabled={unavailable ? true : undefined}
      className="storyboard-bar-generate shrink-0 rounded-full text-body aria-disabled:active:scale-100"
      leadingIcon="video"
      onClick={() => {
        if (!unavailable) onGenerate()
      }}
      size="md"
    >
      {submitting ? '提交中…' : `生成第 ${shotIndex} 组`}
    </Button>
  )
}
