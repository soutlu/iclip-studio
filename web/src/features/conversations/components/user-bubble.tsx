import { useState } from 'react'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { serializePromptContent } from '@/shared/lib/prompt-clipboard'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import {
  MEDIA_KIND_ICON,
  type MediaDescriptor,
  mediaDisplayName,
  MediaPreviewCard,
  mediaThumbnailUrl,
  useHoverPreview,
} from '@/shared/ui/media-preview'
import { CopyButton } from './copy-button'
import { TOUCH_HIT_40 } from './touch-hit'
import { useClampable } from './use-clampable'

type UserBubbleProps = {
  content: readonly PromptContentPart[]
  className?: string
  onEdit?: (() => void) | undefined
  editDisabled?: boolean | undefined
}

const plainText = (content: readonly PromptContentPart[]): string =>
  content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

const copyText = (content: readonly PromptContentPart[]): string =>
  content.some((part) => part.type !== 'text')
    ? serializePromptContent(content)
    : plainText(content)

type MediaPart = Extract<PromptContentPart, { type: 'image' | 'video' }>

export function UserBubble({ className, content, editDisabled = false, onEdit }: UserBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const [viewing, setViewing] = useState<LightboxMedia | null>(null)
  const { clampable, ref } = useClampable(10, content)

  const toggle = (
    <button
      className="ui-state rounded-full border-[0.5px] border-chat-hairline bg-top-layer px-4 py-1.5 text-body-sm text-chat-secondary-text shadow-[var(--shadow-1)] ui-focus"
      onClick={() => setExpanded((value) => !value)}
      type="button"
    >
      {expanded ? '收起' : '展开'}
    </button>
  )

  return (
    <div className={cn('group/bubble flex items-end justify-end gap-1 touch:gap-2', className)}>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity ui-motion-s group-hover/bubble:opacity-100 focus-within:opacity-100 touch:gap-4 touch:opacity-100">
        <CopyButton className={TOUCH_HIT_40} label="复制消息" text={copyText(content)} />
        {onEdit === undefined ? null : (
          <IconButton
            className={cn('text-chat-muted-text', TOUCH_HIT_40)}
            disabled={editDisabled}
            label="修改"
            name="edit"
            onClick={onEdit}
            size="xs"
            variant="standard"
          />
        )}
      </div>
      <div className="flex max-w-[min(80%,100vw-52px)] min-w-0 flex-col">
        <div className="rounded-xl rounded-br-sm bg-chat-user-bg px-3.5 py-2.5 text-body leading-relaxed whitespace-pre-wrap text-chat-message-text">
          <div className="relative flex flex-col">
            <div ref={ref} className={cn(clampable && !expanded && 'chat-clamp')}>
              {content.map((part, index) =>
                part.type === 'text' ? (
                  // eslint-disable-next-line @eslint-react/no-array-index-key
                  <span key={index}>{part.text}</span>
                ) : (
                  // eslint-disable-next-line @eslint-react/no-array-index-key
                  <MediaChip key={index} onOpen={setViewing} part={part} />
                ),
              )}
            </div>
            {clampable && !expanded ? (
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2">{toggle}</div>
            ) : null}
          </div>
        </div>
        {clampable && expanded ? <div className="mt-1 self-center">{toggle}</div> : null}
      </div>
      <MediaLightbox media={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

function MediaChip({ onOpen, part }: { part: MediaPart; onOpen: (media: LightboxMedia) => void }) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null)
  const tip = useHoverPreview()
  const url = part.source.url
  const media: MediaDescriptor = { kind: part.type, name: fileNameOfUrl(url), previewUrl: url }
  const name = mediaDisplayName(media)
  const thumbnail = mediaThumbnailUrl(media)
  const open = () => {
    tip.close()
    onOpen({ kind: part.type, name, url })
  }

  return (
    <>
      <button
        aria-label={name}
        className="mx-0.5 mb-1 inline-flex h-[1lh] max-w-full cursor-zoom-in items-center rounded-sm align-top ui-focus"
        onClick={open}
        onMouseEnter={tip.onEnter}
        onMouseLeave={tip.onLeave}
        ref={setAnchorEl}
        type="button"
      >
        <span className="media-chip min-w-0">
          <span className="media-chip-icon">
            {thumbnail === undefined ? (
              <Icon decorative name={MEDIA_KIND_ICON[media.kind]} size="sm" />
            ) : (
              <img alt="" src={thumbnail} />
            )}
          </span>
          <span className="max-w-32 truncate">{name}</span>
        </span>
      </button>
      {tip.open && anchorEl !== null ? (
        <MediaPreviewCard
          anchorEl={anchorEl}
          media={media}
          onEnter={tip.onEnter}
          onLeave={tip.onLeave}
          onEnlarge={open}
        />
      ) : null}
    </>
  )
}
