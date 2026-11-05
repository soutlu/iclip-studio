import type { KeyboardEvent, ReactNode } from 'react'
import { DialogRoot, DialogSurface } from '@/shared/ui/dialog'

type LibraryViewerFrameProps = {
  onClose: () => void
  onRestoreFocus: () => boolean
  onKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined
  onEscapeKeyDown?: ((event: globalThis.KeyboardEvent) => void) | undefined
  children: ReactNode
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
