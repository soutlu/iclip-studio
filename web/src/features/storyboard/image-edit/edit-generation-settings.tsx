import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { GenerationPicker } from '../components/generation-picker'
import {
  isChannel,
  isResolution,
  modelSupportsAspect,
  type ImageChannel,
  type ImageModel,
  type ImageResolution,
  type ResolvedImageOptions,
} from './image-edit.api'

type EditGenerationSettingsProps = {
  models: readonly ImageModel[]
  options: ResolvedImageOptions
  aspectRatio: string
  disabled: boolean
  onModelChange: (value: string) => void
  onChannelChange: (value: ImageChannel) => void
  onResolutionChange: (value: ImageResolution) => void
}

/** 常用选项就地选择，渠道收在菜单中；选项收敛仍由 image-edit.api 统一处理。 */
export function EditGenerationSettings({
  models,
  options: { model, resolution, channel, aspectUnsupported },
  aspectRatio,
  disabled,
  onModelChange,
  onChannelChange,
  onResolutionChange,
}: EditGenerationSettingsProps) {
  if (aspectUnsupported) {
    return (
      <p role="alert" className="text-body-sm text-error">
        暂无模型支持 {aspectRatio}，请先调整分镜画幅
      </p>
    )
  }

  return (
    <div className="image-edit-settings">
      <div className="image-edit-settings-controls">
        <GenerationPicker
          className="image-edit-model-picker"
          disabled={disabled || models.length === 0}
          label="图片模型"
          leading={<Icon decorative name="image" size="sm" />}
          onChange={onModelChange}
          options={models.map((item) => {
            // 画幅由分镜决定，做不了它的模型置灰标出来，不从清单里藏掉。
            const usable = modelSupportsAspect(item, aspectRatio)
            return {
              disabled: !usable,
              hint: usable ? undefined : '不支持',
              label: item.label,
              value: item.model,
            }
          })}
          text={model?.label ?? '读取模型中…'}
          value={model?.model ?? ''}
        />
        <GenerationPicker
          disabled={disabled || resolution === undefined}
          label="图片分辨率"
          onChange={(value) => {
            if (isResolution(value)) onResolutionChange(value)
          }}
          options={(model?.resolutions ?? []).map((value) => ({
            label: value.toUpperCase(),
            value,
          }))}
          text={resolution?.toUpperCase() ?? ''}
          value={resolution ?? ''}
        />
        {channel !== undefined ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton
                className="shrink-0"
                disabled={disabled}
                label="更多生成设置"
                name="settings"
                size="md"
              />
            </MenuTrigger>
            <MenuSurface align="end" aria-label="生成设置">
              <p className="px-2 py-1 text-caption text-on-surface-muted">生成渠道</p>
              <MenuRadioGroup
                aria-label="图片生成渠道"
                value={channel}
                onValueChange={(value) => {
                  if (isChannel(value)) onChannelChange(value)
                }}
              >
                {model?.channels.map((value) => (
                  <MenuRadioItem key={value} value={value} disabled={disabled}>
                    {value}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        ) : null}
      </div>
      <p className="text-caption text-on-surface-muted">
        <span title="画幅跟随分镜">{aspectRatio}</span>
        {channel === undefined ? null : <span> · {channel}</span>}
      </p>
    </div>
  )
}
