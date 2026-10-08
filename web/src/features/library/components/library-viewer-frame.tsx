/** 资料库详情的外壳：铺满视口的弹窗，中间一个左播右文的框；成片与参考视频的详情共用。 */

import type { KeyboardEvent, ReactNode } from 'react'
import { DialogRoot, DialogSurface } from '@/shared/ui/dialog'

type LibraryViewerFrameProps = {
  onClose: () => void
  /** 关掉后由列表把焦点放回卡片；卡片已被虚拟列表回收时返回 false，交给弹窗的默认去处。 */
  onRestoreFocus: () => boolean
  onKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined
  /** Esc 默认关掉详情；框里有进行到一半的事（如编辑）时由调用方拦下，先退出那件事。 */
  onEscapeKeyDown?: ((event: globalThis.KeyboardEvent) => void) | undefined
  /** 框里的内容：左边播放区、右边文字栏。 */
  children: ReactNode
  /** 框外、弹窗里的东西，如两侧翻条按钮；排在框后面，打开时焦点先落到框里。 */
  outside?: ReactNode
}

export function LibraryViewerFrame({
  onClose,
  onRestoreFocus,
  onKeyDown,
  onEscapeKeyDown,
  children,
  outside,
}: LibraryViewerFrameProps) {
  return (
    <DialogRoot
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogSurface
        aria-describedby={undefined}
        bare
        className="inset-0 top-0 left-0 grid h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 place-items-center max-sm:top-0 max-sm:max-h-none md:p-6 lg:px-22 lg:py-8"
        onCloseAutoFocus={(event) => {
          if (onRestoreFocus()) event.preventDefault()
        }}
        {...(onEscapeKeyDown === undefined ? {} : { onEscapeKeyDown })}
        onKeyDown={onKeyDown}
        // 弹层铺满视口，框外的空白也在弹层里：按下落在空白处就关。
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        overlayClassName="bg-scrim/60 backdrop-blur-sm"
      >
        <div className="relative flex size-full max-h-215 min-h-0 max-w-310 overflow-hidden bg-surface-container-lowest text-on-surface shadow-[var(--shadow-3)] max-md:flex-col max-md:overflow-y-auto md:rounded-2xl">
          {children}
        </div>
        {outside}
      </DialogSurface>
    </DialogRoot>
  )
}
