/** 全屏媒体预览。作为 Radix Dialog 进层栈：在弹窗里打开时 Escape 与点击只关它自己，宿主弹窗留在原地。 */

import { Dialog as DialogPrimitive } from 'radix-ui'
import { useRef } from 'react'
import { Icon } from '@/shared/icons'
import { refuseFileDropProps } from '@/shared/ui/file-drop'
import { VIDEO_PLAYER_SELECTOR, VideoPlayer } from '@/shared/ui/video-player'

export type LightboxMedia = {
  kind: 'image' | 'video'
  url: string
  name: string
  /** 视频从这一秒起播；从内嵌播放器放大时带上它当时的进度。 */
  startAt?: number | undefined
  /** 视频封面。 */
  poster?: string | undefined
}

type MediaLightboxProps = {
  media: LightboxMedia | null
  /** 关掉预览；视频带回灯箱里播到的秒数，内嵌播放器据此接着定位。 */
  onClose: (currentTime?: number) => void
}

export function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // 打开它的是各处任意按钮而不是 Dialog.Trigger，关掉后 Radix 不知道该把焦点还给谁，自己记。
  const openerRef = useRef<HTMLElement | null>(null)
  return (
    <DialogPrimitive.Root
      open={media !== null}
      onOpenChange={(open) => {
        if (!open) onClose(videoRef.current?.currentTime)
      }}
    >
      {media === null ? null : (
        <DialogPrimitive.Portal>
          {/* 与弹窗同一 z 层；后挂到 body 的盖在前面，与「选择参考帧」这类嵌套弹窗同一套规则。 */}
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="media-lightbox layer-popup fixed inset-0 grid animate-in place-items-center p-6 duration-(--dur-m) fade-in"
            onOpenAutoFocus={(event) => {
              openerRef.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null
              // 默认会聚焦铺满全屏的关闭区，焦点环框住整个视口。视频聚焦播放器，空格等快捷键直接可用；
              // 图片聚焦右上角的关闭按钮。程序聚焦不画焦点环。
              event.preventDefault()
              const player = videoRef.current?.closest<HTMLElement>(VIDEO_PLAYER_SELECTOR)
              if (player) player.focus({ focusVisible: false })
              else closeRef.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              openerRef.current?.focus()
            }}
            {...refuseFileDropProps}
          >
            <DialogPrimitive.Title className="sr-only">{media.name}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="关闭预览"
              className="absolute inset-0 cursor-zoom-out"
              type="button"
            />
            {media.kind === 'video' ? (
              // 画面按自身比例撑开播放器；灯箱里没有放大，双击只是两次切换播放。
              <VideoPlayer
                autoPlay
                className="animate-in duration-(--dur-m) zoom-in-95"
                label={media.name}
                poster={media.poster}
                ref={videoRef}
                src={media.url}
                startAt={media.startAt}
                videoClassName="media-lightbox-media size-auto"
              />
            ) : (
              <img
                alt={media.name}
                className="media-lightbox-media relative animate-in duration-(--dur-m) zoom-in-95"
                src={media.url}
              />
            )}
            <DialogPrimitive.Close
              aria-label="关闭"
              className="absolute top-4 right-6 grid size-(--control-height-md) cursor-pointer place-items-center rounded-full text-on-scrim ui-focus ui-motion-s hover:opacity-70"
              ref={closeRef}
              type="button"
            >
              <Icon decorative name="close" size="lg" />
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}
