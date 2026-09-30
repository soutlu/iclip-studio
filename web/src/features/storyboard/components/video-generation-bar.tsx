/** 分镜工作台底部的出片栏：一排生成设置（模型、分辨率、画幅、音频），加唯一的主色按钮出当前这一组。
 * 各档宽度下怎么排见 storyboard.css 的出片栏一节。 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { ASPECT_RATIOS } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Select } from '@/shared/ui/field'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  MODELS_PENDING_TEXT,
  VIDEO_RESOLUTIONS,
  type VideoGenerationOptions,
  type VideoModelsStatus,
} from '../video-generation-options'
import { supportsAspectRatio } from '../video-model-support'

/** 全栏唯一的次级控件配方，与 ChipGroup segmented 同高同底；主色只留给出片按钮。 */
const CONTROL_CLASS =
  'h-8 shrink-0 rounded-sm bg-surface-container text-body-sm text-on-surface ui-state ui-focus'

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
  const fade = useScrollFade(paramsRef)

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
        <div className="storyboard-bar-params" data-fade={fade} ref={paramsRef}>
          <Select
            aria-label="视频模型"
            className={cn(CONTROL_CLASS, 'pr-6 pl-2.5 font-mono')}
            disabled={submitting || models.items.length === 0}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            title={modelLabel}
            value={value.model ?? ''}
            variant="inline"
            // 工作台窄时模型 id 截断，完整 id 靠 title 悬停看。
            wrapperClassName="storyboard-bar-model"
          >
            {value.model === undefined ? <option value="">{modelLabel}</option> : null}
            {models.items.map((model) => (
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
          <AspectSelect aspect={aspect} model={value.model} />
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
          blockedReason={blocker}
          onGenerate={onGenerate}
          shotIndex={shotIndex}
          submitting={submitting}
        />
      </div>
    </div>
  )
}

/** 画幅下拉；选中模型做不了的档位置灰并标「（不支持）」。 */
function AspectSelect({ aspect, model }: { aspect: AspectControl; model: string | undefined }) {
  return (
    <Select
      aria-label="画幅"
      className={cn(CONTROL_CLASS, 'pr-6 pl-2.5')}
      disabled={aspect.disabled}
      onChange={(event) => aspect.onChange(event.target.value)}
      value={aspect.value}
      variant="inline"
      wrapperClassName="shrink-0"
    >
      {/* agent 可以写任何 宽:高，不在档位里的也要照原样显示得出来。 */}
      {ASPECT_RATIOS.some((ratio) => ratio === aspect.value) ? null : (
        <option value={aspect.value}>{aspect.value}</option>
      )}
      {ASPECT_RATIOS.map((ratio) => {
        const usable = supportsAspectRatio(model, ratio)
        // 选中的那个不加后缀：收起来的下拉只显示它，长文案会把一排控件挤开；
        // 它正好不被支持时，栏里那句常显的提示已经在说了。
        const label = usable || ratio === aspect.value ? ratio : `${ratio}（不支持）`
        return (
          <option disabled={!usable} key={ratio} value={ratio}>
            {label}
          </option>
        )
      })}
    </Select>
  )
}

type ScrollFade = 'none' | 'start' | 'end' | 'both'

/** 横向滚动行哪一端还有内容没露出来；样式按它给那一端加渐隐。放得下时为 none。 */
function useScrollFade(ref: { current: HTMLElement | null }): ScrollFade {
  const [fade, setFade] = useState<ScrollFade>('none')
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => {
      const start = element.scrollLeft > 0
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setFade(start && end ? 'both' : start ? 'start' : end ? 'end' : 'none')
    }
    // ResizeObserver 开始观察时会先回调一次，初始状态由它量，不在副作用里同步设。
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [ref])
  return fade
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
          className="storyboard-bar-generate shrink-0 rounded-full text-body aria-disabled:active:scale-100"
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
