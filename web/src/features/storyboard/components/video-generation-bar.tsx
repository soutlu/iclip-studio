/** 分镜工作台底部的出片栏：一排控件（最左是写回分镜的画幅，竖线隔开后是模型、分辨率、音频三项生成设置），
 * 加唯一的主色按钮出当前这一组；控件上方一行常显的状态，说明为什么不能出片或哪里有问题。
 * 各档宽度下怎么排见 storyboard.css 的出片栏一节。 */

import { useId, useRef } from 'react'
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
  /** 出片被挡住的原因；有它时主按钮置灰，状态行写出原因。 */
  blocker: string | undefined
  /** 出片栏要提醒的错误（上次提交失败的原话、画幅不被模型支持）；没被挡住时写在状态行上。 */
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
  const statusId = useId()
  const status = barStatusOf(blocker, notice)

  return (
    <div
      aria-label="出片工具栏"
      className="storyboard-bar rounded-xl border-[0.5px] border-hairline bg-surface-container-lowest shadow-[var(--shadow-2)]"
      role="group"
    >
      {status === undefined ? null : <BarStatusLine id={statusId} status={status} />}
      <div className="storyboard-bar-row">
        <div
          className="storyboard-bar-params storyboard-scroll-fade"
          data-fade={fade}
          ref={paramsRef}
        >
          <AspectPicker
            aspect={aspect}
            // 状态行此刻写的是错误时，画幅出错就由它说明；写着置灰原因时那句与画幅无关。
            errorId={status?.tone === 'error' ? statusId : undefined}
            model={value.model}
          />
          <span aria-hidden className="storyboard-bar-divider" />
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
          describedBy={status === undefined ? undefined : statusId}
          onGenerate={onGenerate}
          shotIndex={shotIndex}
          submitting={submitting}
        />
      </div>
    </div>
  )
}

/** 状态行写什么：置灰原因优先（主按钮的说明就指向这一行，写的必须是它），其次是要提醒的错误。 */
type BarStatus = { tone: 'blocked' | 'error'; text: string }

const barStatusOf = (
  blocker: string | undefined,
  notice: string | undefined,
): BarStatus | undefined => {
  if (blocker !== undefined) return { text: blocker, tone: 'blocked' }
  if (notice !== undefined) return { text: notice, tone: 'error' }
  return undefined
}

/** 控件上方常显的一行。错误用 alert 播报；置灰原因不播报（自动保存时会反复出现），由主按钮的说明关联读出。 */
function BarStatusLine({ id, status }: { id: string; status: BarStatus }) {
  const error = status.tone === 'error'
  return (
    <p
      className="storyboard-bar-status"
      data-tone={status.tone}
      id={id}
      role={error ? 'alert' : undefined}
      // 窄时截断，完整的字靠悬停看。
      title={status.text}
    >
      <Icon decorative name={error ? 'alert' : 'info'} size="xs" />
      <span className="truncate">{status.text}</span>
    </p>
  )
}

/** 画幅选择器；选中模型做不了的档位置灰并标「不支持」，不替用户改。当前画幅做不了时按钮本身标成错误态，
 * `errorId` 指向说明原因的状态行。 */
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
      description="画幅写回分镜，不是生成参数"
      disabled={aspect.disabled}
      invalid={unsupported ? { describedBy: errorId } : undefined}
      label="画幅"
      leading={
        unsupported ? (
          <Icon decorative name="alert" size="sm" />
        ) : (
          <AspectGlyph longSide={13} ratio={aspect.value} />
        )
      }
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

/** 出片主按钮：被挡住或提交中时用 aria-disabled 置灰，仍可聚焦，说明关联到状态行；能出片时不带这个属性。 */
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
