import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { AspectGlyph } from '../components/aspect-glyph'
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
  aspectNote: string
  onModelChange: (value: string) => void
  onChannelChange: (value: ImageChannel) => void
  onResolutionChange: (value: ImageResolution) => void
}

export function EditGenerationSettings({
  models,
  options: { model, resolution, channel },
  aspectRatio,
  aspectNote,
  onModelChange,
  onChannelChange,
  onResolutionChange,
}: EditGenerationSettingsProps) {
  return (
    <div className="image-edit-settings">
      <span className="image-edit-aspect" title={aspectNote}>
        <AspectGlyph longSide={13} ratio={aspectRatio} />
        <span aria-hidden="true">{aspectRatio}</span>
        <span className="sr-only">{aspectNote}</span>
      </span>
      <GenerationPicker
        className="image-edit-model-picker"
        disabled={models.length === 0}
        label="图片模型"
        leading={<Icon decorative name="image" size="sm" />}
        onChange={onModelChange}
        options={models.map((item) => {
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
        disabled={resolution === undefined}
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
              className="image-edit-settings-more shrink-0"
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
                <MenuRadioItem key={value} value={value}>
                  {value}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>
      ) : null}
    </div>
  )
}
