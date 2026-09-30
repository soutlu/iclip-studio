/** 分镜工作台底部的出片栏：一排生成设置（模型、分辨率、画幅、音频），加唯一的主色按钮出当前这一组。
 * 各档宽度下怎么排见 storyboard.css 的出片栏一节。 */

import { useRef } from 'react'
import { Icon } from '@/shared/icons'
import { ASPECT_RATIOS, aspectOf } from '@/shared/lib/aspect-ratio'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  MODELS_PENDING_TEXT,
  VIDEO_RESOLUTIONS,
  type VideoGenerationOptions,
  type VideoModelsStatus,
} from '../video-generation-options'
import { supportsAspectRatio } from '../video-model-support'
import { BlockedReason } from './blocked-reason'
import { GenerationPicker, type GenerationPickerOption } from './generation-picker'
import { useScrollFade } from './use-scroll-fade'

/** 分镜的画幅：写回分镜文件，不是生成选项。 */
type AspectControl = {
  value: string
  disabled: boolean
  onChange: (aspectRatio: string) => void
}

type VideoGenerationBarProps = {
  /** 当前镜头组的镜号，主按钮写的就是它。 */
  shotIndex: number
  models: { items: readonly string[]; status: VideoModelsStatus }
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
  aspect: AspectControl
  /** 出片被挡住的原因；有它时主按钮置灰，悬停、聚焦或点按说明原因。 */
  blocker: string | undefined
  /** 挨着出片按钮常显的一句（上次提交失败的原话、画幅不被模型支持），不靠悬停。 */
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
  // 模型只有 id，没有展示名；清单还没到手时先占个位。
  const modelLabel =
    value.model ?? (models.status === 'ready' ? '' : MODELS_PENDING_TEXT[models.status])
  const paramsRef = useRef<HTMLDivElement | null>(null)
  const { fade } = useScrollFade(paramsRef)

  return (
    <div
      aria-label="出片工具栏"
      className="storyboard-bar rounded-xl border-[0.5px] border-hairline bg-surface-container-lowest shadow-[var(--shadow-2)]"
      role="group"
    >
      {notice === undefined ? null : (
        <p className="truncate text-body-sm text-error" role="alert" title={notice}>
          {notice}
        </p>
      )}
      <div className="storyboard-bar-row">
        <div
          className="storyboard-bar-params storyboard-scroll-fade"
          data-fade={fade}
          ref={paramsRef}
        >
          <GenerationPicker
            // 工作台窄时模型 id 截断，尺寸规则见出片栏一节。
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
            // Radix 再点一次已选项会给空串，不在档位里的值一律忽略，分辨率始终有值。
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
          <AspectPicker aspect={aspect} model={value.model} />
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
          blockedReason={blocker}
          onGenerate={onGenerate}
          shotIndex={shotIndex}
          submitting={submitting}
        />
      </div>
    </div>
  )
}

/** 画幅选择器；选中模型做不了的档位置灰并标「不支持」，不替用户改。 */
function AspectPicker({ aspect, model }: { aspect: AspectControl; model: string | undefined }) {
  const options: GenerationPickerOption[] = ASPECT_RATIOS.map((ratio) => {
    const usable = supportsAspectRatio(model, ratio)
    return {
      disabled: !usable,
      hint: usable ? undefined : '不支持',
      leading: <AspectGlyph longSide={14} ratio={ratio} />,
      value: ratio,
    }
  })
  // agent 可以写任何 宽:高，不在档位里的也要照原样显示得出来，并在菜单里勾着它。
  if (!ASPECT_RATIOS.some((ratio) => ratio === aspect.value))
    options.unshift({
      leading: <AspectGlyph longSide={14} ratio={aspect.value} />,
      value: aspect.value,
    })
  return (
    <GenerationPicker
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

/** 按画幅描的小方框，长边 `longSide` 像素；认不出的画幅按 9:16 描（见 `aspectOf`）。 */
function AspectGlyph({ longSide, ratio }: { longSide: number; ratio: string }) {
  const { h, w } = aspectOf(ratio)
  const scale = longSide / Math.max(w, h)
  return (
    <span
      aria-hidden
      className="storyboard-bar-glyph"
      style={{ height: Math.round(h * scale), width: Math.round(w * scale) }}
    />
  )
}

/** 出片主按钮：被挡住时用 aria-disabled 置灰并说明原因（见 `BlockedReason`）；能出片时不带这个属性。 */
function GenerateButton({
  blockedReason,
  onGenerate,
  shotIndex,
  submitting,
}: {
  blockedReason: string | undefined
  onGenerate: () => void
  shotIndex: number
  submitting: boolean
}) {
  const unavailable = submitting || blockedReason !== undefined
  return (
    <BlockedReason reason={blockedReason}>
      <Button
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
    </BlockedReason>
  )
}
