import { Toaster as SonnerToaster, toast } from 'sonner'

export { toast }

export function Toaster() {
  return (
    <SonnerToaster
      duration={4000}
      position="bottom-center"
      toastOptions={{
        unstyled: true,
        classNames: {
          // sonner 直接拼接基础与状态类名，需通过 data-type 属性选择器提升状态背景色优先级。
          toast:
            'flex w-full items-center gap-[9px] rounded-md bg-inverse-surface py-[9px] pr-[10px] pl-[17px] text-label text-inverse-on-surface shadow-[var(--shadow-3)] data-[type=error]:bg-error-container data-[type=error]:text-on-error-container',
          actionButton:
            'ui-focus ml-auto cursor-pointer rounded-sm px-2 py-1 font-semibold whitespace-nowrap text-inverse-primary in-data-[type=error]:text-on-error-container in-data-[type=error]:underline in-data-[type=error]:underline-offset-3',
          closeButton: 'ui-focus cursor-pointer rounded-full',
        },
      }}
    />
  )
}
