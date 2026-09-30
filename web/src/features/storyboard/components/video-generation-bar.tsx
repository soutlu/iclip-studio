/** 分镜工作台底部的出片栏：左边一排生成设置（模型、分辨率、画幅、音频），右边唯一的主色按钮出当前这一组。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { ASPECT_RATIOS } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Select } from '@/shared/ui/field'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VIDEO_RESOLUTIONS, type VideoGenerationOptions } from '../video-generation-options'
import { supportsAspectRatio } from '../video-model-support'

/** 全栏唯一的次级控件配方，与 ChipGroup segmented 同高同底；主色只留给出片按钮。 */
const CONTROL_CLASS =
  'h-8 shrink-0 rounded-sm bg-surface-container text-body-sm text-on-surface ui-state ui-focus'

type VideoGenerationBarProps = {
  /** 当前镜头组的镜号，主按钮写的就是它。 */
  shotIndex: number
  models: readonly string[]
  /** 模型清单读不到时给用户看的原因；还在读就不传。 */
  modelsUnavailable?: string | undefined
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
  aspectRatio: string
  aspectRatioDisabled: boolean
  onAspectRatioChange: (aspectRatio: string) => void
  /** 出片被挡住的原因；有它时主按钮置灰，悬停、聚焦或点按说明原因。 */
  blockedReason: string | undefined
  /** 挨着出片按钮常显的一句（上次提交失败的原话、画幅不被模型支持），不靠悬停。 */
  notice: string | undefined
  submitting: boolean
  onGenerate: () => void
}

export function VideoGenerationBar({
  aspectRatio,
  aspectRatioDisabled,
  blockedReason,
  models,
  modelsUnavailable,
  notice,
  onAspectRatioChange,
  onChange,
  onGenerate,
  shotIndex,
  submitting,
  value,
}: VideoGenerationBarProps) {
  // 模型只有 id，没有展示名；清单还没读到时先占个位。
  const modelLabel = value.model ?? modelsUnavailable ?? '读取模型…'

  return (
    <div
      aria-label="出片工具栏"
      className="mx-4 mt-1 mb-4 flex shrink-0 flex-col gap-2 rounded-xl border-[0.5px] border-hairline bg-surface-container-lowest py-2.5 pr-2.5 pl-3 shadow-[var(--shadow-2)]"
      role="group"
    >
      {notice === undefined ? null : (
        <p className="truncate text-body-sm text-error" role="alert" title={notice}>
          {notice}
        </p>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Select
            aria-label="视频模型"
            className={cn(CONTROL_CLASS, 'pr-6 pl-2.5 font-mono')}
            disabled={submitting || models.length === 0}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            title={modelLabel}
            value={value.model ?? ''}
            variant="inline"
            // 工作台窄时模型 id 截断，完整 id 靠 title 悬停看。
            wrapperClassName="min-w-0 @max-[640px]:max-w-30"
          >
            {value.model === undefined ? <option value="">{modelLabel}</option> : null}
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </Select>
          <ChipGroup
            aria-label="分辨率"
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
                className="px-2.5"
                key={resolution}
                value={resolution}
                variant="segmented"
              >
                {resolution}
              </FilterChip>
            ))}
          </ChipGroup>
          <Select
            aria-label="画幅"
            className={cn(CONTROL_CLASS, 'pr-6 pl-2.5')}
            disabled={aspectRatioDisabled}
            onChange={(event) => onAspectRatioChange(event.target.value)}
            value={aspectRatio}
            variant="inline"
            wrapperClassName="shrink-0"
          >
            {/* agent 可以写任何 宽:高，不在档位里的也要照原样显示得出来。 */}
            {ASPECT_RATIOS.some((ratio) => ratio === aspectRatio) ? null : (
              <option value={aspectRatio}>{aspectRatio}</option>
            )}
            {ASPECT_RATIOS.map((ratio) => {
              const usable = supportsAspectRatio(value.model, ratio)
              // 选中的那个不加后缀：收起来的下拉只显示它，长文案会把一排控件挤开；
              // 它正好不被支持时，栏里那句常显的提示已经在说了。
              const label = usable || ratio === aspectRatio ? ratio : `${ratio}（不支持）`
              return (
                <option disabled={!usable} key={ratio} value={ratio}>
                  {label}
                </option>
              )
            })}
          </Select>
          <TooltipRoot>
            <TooltipTrigger asChild>
              <button
                aria-label="生成音频"
                aria-pressed={value.generateAudio}
                className={cn(CONTROL_CLASS, 'inline-grid w-8 cursor-pointer place-items-center')}
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
          blockedReason={blockedReason}
          onGenerate={onGenerate}
          shotIndex={shotIndex}
          submitting={submitting}
        />
      </div>
    </div>
  )
}

/** 置灰用 aria-disabled 而不是原生 disabled：原因要悬停、聚焦、点按都看得到，原生 disabled 的按钮
 * 收不到指针，也进不了 tab 序列。能出片时不带这个属性；点击靠 onClick 里的守卫拦下。
 * 触屏没有悬停，点按也要亮出原因，做法同资料库的「做同款」。 */
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
  const [hint, setHint] = useState(false)
  const blocked = blockedReason !== undefined
  const unavailable = submitting || blocked
  return (
    <TooltipRoot onOpenChange={(open) => setHint(open && blocked)} open={hint && blocked}>
      <TooltipTrigger
        asChild
        // 拦下默认处理，Radix 才不会在点按时把提示关掉。
        onClick={(event) => {
          if (!blocked) return
          event.preventDefault()
          setHint(true)
        }}
      >
        <Button
          aria-disabled={unavailable ? true : undefined}
          className="shrink-0 rounded-full text-body aria-disabled:active:scale-100"
          leadingIcon="video"
          onClick={() => {
            if (!unavailable) onGenerate()
          }}
          size="md"
        >
          {submitting ? '提交中…' : `生成第 ${shotIndex} 组`}
        </Button>
      </TooltipTrigger>
      {blocked ? <TooltipContent side="top">{blockedReason}</TooltipContent> : null}
    </TooltipRoot>
  )
}
