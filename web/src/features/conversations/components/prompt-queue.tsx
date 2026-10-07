/** 队列状态来自服务端 prompts；仅提供追加和撤回，服务端没有重排接口。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { mediaDisplayName } from '@/shared/ui/media-preview'
import { useClampable } from './use-clampable'

type QueueItem = {
  promptId: string
  text: string
  media: readonly { kind: 'image' | 'video'; url: string }[]
}

type PromptQueueProps = {
  prompts: readonly QueueItem[]
  /** 仅运行中的轮次支持立即追加。 */
  canSteer: boolean
  /** 看别人的对话：队列只展示，没有追加与撤回。 */
  readOnly: boolean
  onSteer: (promptId: string) => void
  onDiscard: (promptId: string) => void
}

export function PromptQueue({ canSteer, onDiscard, onSteer, prompts, readOnly }: PromptQueueProps) {
  const [viewing, setViewing] = useState<LightboxMedia | null>(null)

  return (
    <>
      {prompts.length === 0 ? null : (
        <section aria-label="排队队列" className="flex w-full flex-col items-end gap-2">
          <p className="flex items-center gap-1 px-1.5 text-body-sm text-chat-muted-text">
            <Icon decorative name="mail" size="xs" />
            {prompts.length} 条消息等着发
          </p>
          {prompts.map((prompt, index) => (
            <QueueRow
              canSteer={canSteer && !readOnly}
              first={index === 0}
              key={prompt.promptId}
              onDiscard={onDiscard}
              onOpenMedia={setViewing}
              onSteer={onSteer}
              prompt={prompt}
              readOnly={readOnly}
            />
          ))}
        </section>
      )}
      {/* 挂在队列外：正在看的那条被发走、队列清空时，灯箱不跟着消失。 */}
      <MediaLightbox media={viewing} onClose={() => setViewing(null)} />
    </>
  )
}

type QueueRowProps = {
  prompt: QueueItem
  first: boolean
  canSteer: boolean
  readOnly: boolean
  onSteer: (promptId: string) => void
  onDiscard: (promptId: string) => void
  onOpenMedia: (media: LightboxMedia) => void
}

function QueueRow({
  canSteer,
  first,
  onDiscard,
  onOpenMedia,
  onSteer,
  prompt,
  readOnly,
}: QueueRowProps) {
  const { clampable, ref } = useClampable(3, prompt.text)

  return (
    <div className="flex items-center justify-end gap-2">
      {first && canSteer ? (
        <button
          aria-label="现在就发"
          className="grid size-(--control-height-xs) shrink-0 cursor-pointer place-items-center rounded-full bg-inverse-surface text-inverse-on-surface shadow-[var(--shadow-xs)] ui-focus transition-[background-color,transform] ui-motion-s active:scale-90"
          onClick={() => onSteer(prompt.promptId)}
          type="button"
        >
          <Icon decorative name="send" size="sm" />
        </button>
      ) : null}
      <div className="group flex max-w-[min(88%,100vw-52px)] ui-state items-center gap-2 rounded-md bg-chat-user-bg py-1.5 pr-1.5 pl-2.5">
        {prompt.text === '' && prompt.media.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-body-sm text-chat-muted-text">
            <Icon decorative name="file" size="sm" />
            附件 ×{prompt.media.length}
          </span>
        ) : (
          <span
            ref={ref}
            className={cn(
              'min-w-0 text-body-sm whitespace-pre-wrap text-chat-message-text opacity-80 group-hover:opacity-100',
              clampable && 'chat-q-clamp',
            )}
          >
            {prompt.text}
          </span>
        )}
        {prompt.media.length > 0 ? (
          <span className="flex shrink-0 gap-1">
            {prompt.media.map((media) => {
              const name = mediaDisplayName({ kind: media.kind, name: fileNameOfUrl(media.url) })
              return (
                <button
                  aria-label={name}
                  className="shrink-0 cursor-zoom-in rounded-xs ui-focus"
                  key={media.url}
                  onClick={() => onOpenMedia({ kind: media.kind, name, url: media.url })}
                  type="button"
                >
                  {media.kind === 'image' ? (
                    <img
                      alt=""
                      className="size-7 rounded-xs border-[0.5px] border-chat-hairline object-cover"
                      src={media.url}
                    />
                  ) : (
                    <span className="grid size-7 place-items-center rounded-xs border-[0.5px] border-chat-hairline text-chat-muted-text">
                      <Icon decorative name="video" size="sm" />
                    </span>
                  )}
                </button>
              )
            })}
          </span>
        ) : null}
        {first ? (
          <span className="shrink-0 rounded-full bg-secondary-container px-1.5 py-0.5 text-caption text-on-secondary-container">
            下一条
          </span>
        ) : null}
        {readOnly ? null : (
          <button
            aria-label="撤回"
            className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-xs text-chat-muted-text opacity-0 ui-focus transition-[opacity,color,background-color] ui-motion-s group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-danger-bg hover:text-danger-text touch:opacity-100"
            onClick={() => onDiscard(prompt.promptId)}
            type="button"
          >
            <Icon decorative name="close" size="xs" />
          </button>
        )}
      </div>
    </div>
  )
}
