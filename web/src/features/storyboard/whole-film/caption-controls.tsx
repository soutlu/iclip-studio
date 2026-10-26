import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { CatalogItem, ComponentCatalog } from './component-catalog'
import { ComponentThumb } from './components-panel'
import type { useSubtitleRecognition } from './use-subtitle-recognition'

type Recognition = ReturnType<typeof useSubtitleRecognition>

/**
 * 字幕标题：全部字幕的开关、显示并更换当前样式；只有图标的识别入口独立显示提交、运行与重试状态。
 * 开关是按下态按钮（开着为按下），名字随状态说下一步（关闭字幕 / 打开字幕），没有字幕时也能点。
 */
export function CaptionControls({
  catalog,
  component,
  styles,
  onStyle,
  hidden,
  onToggleHidden,
  recognition,
  statusId,
}: {
  catalog: ComponentCatalog
  component: string
  styles: readonly CatalogItem[]
  onStyle: (component: string) => void
  hidden: boolean
  onToggleHidden: () => void
  recognition: Recognition
  statusId: string
}) {
  const title = styles.find((style) => style.name === component)?.title ?? '样式不可用，请重新选择'
  const toggleLabel = hidden ? '打开字幕' : '关闭字幕'
  const failed = recognition.status === 'failed' || recognition.status === 'read-error'
  return (
    <>
      <button
        aria-label={toggleLabel}
        aria-pressed={!hidden}
        className={cn('wf-caption-toggle ui-state', hidden && 'text-on-surface-muted')}
        onClick={onToggleHidden}
        title={toggleLabel}
        type="button"
      >
        <Icon decorative name={hidden ? 'captions-off' : 'captions'} size="sm" />
      </button>
      <MenuRoot>
        <MenuTrigger asChild>
          <button
            aria-label={`字幕样式：${title}`}
            className="wf-caption-style ui-state text-on-surface-muted"
            title={`字幕样式：${title}`}
            type="button"
          >
            <span>{title}</span>
            <Icon className="wf-caption-disclosure" decorative name="expand" size="xs" />
          </button>
        </MenuTrigger>
        <MenuSurface align="start" className="wf-caption-menu" side="top">
          <span className="px-2 py-1 text-caption text-on-surface-muted">字幕样式</span>
          <MenuRadioGroup onValueChange={onStyle} value={component}>
            {styles.map((style) => (
              <MenuRadioItem key={style.name} value={style.name}>
                <span className="wf-caption-style-option">
                  <ComponentThumb
                    catalog={catalog}
                    className="wf-caption-style-thumb"
                    iconSize="xs"
                    item={style}
                  />
                  <span className="wf-caption-style-name">{style.title}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSurface>
      </MenuRoot>
      <button
        aria-busy={recognition.busy}
        aria-describedby={statusId}
        aria-label={recognition.accessibleLabel}
        className={cn(
          'wf-caption-recognize ui-state bg-surface-container-lowest text-on-surface-variant disabled:bg-surface-container',
          failed && 'text-error',
        )}
        disabled={recognition.disabled}
        onClick={() => void recognition.recognize()}
        title={recognition.message}
        type="button"
      >
        <Icon
          className={cn(recognition.busy && 'animate-spin motion-reduce:animate-none')}
          decorative
          name={recognition.busy ? 'spinner' : failed ? 'refresh' : 'recognize-text'}
          size="xs"
        />
      </button>
    </>
  )
}

/** 有字幕时只在进行中或失败时覆盖一小块状态，旧结果继续显示并可编辑。 */
export function CaptionStatus({
  recognition,
  hasCaptions,
  id,
}: {
  recognition: Recognition
  hasCaptions: boolean
  id: string
}) {
  const quiet = hasCaptions && recognition.status === 'completed'
  const message =
    !hasCaptions && recognition.status === 'completed'
      ? '识别已完成，当前片段范围内没有字幕'
      : recognition.message
  return (
    <span
      className={cn(
        quiet ? 'sr-only' : 'wf-caption-status',
        !quiet && hasCaptions && 'is-overlaid',
        (recognition.status === 'failed' || recognition.status === 'read-error') && 'is-error',
      )}
      id={id}
      role="status"
      title={message}
    >
      {message}
    </span>
  )
}
