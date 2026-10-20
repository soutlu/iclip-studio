import { Toaster as SonnerToaster, toast } from 'sonner'

export { toast }

/** 应用仅挂载一次 Toaster；sonner 管理交互，classNames 提供契约外观。默认 4 秒，带 action 时调用方设置 8 秒。 */
export function Toaster() {
  return (
    <SonnerToaster
      duration={4000}
      position="bottom-center"
      toastOptions={{
        unstyled: true,
        classNames: {
          // sonner 把 toast 与 error 两组类名直接拼接、不做合并，error 的底色压不过基础底色；
          // 用 data-type 属性选择器提高优先级，底色与文字成对切换。
          toast:
            'flex w-full items-center gap-[9px] rounded-md bg-inverse-surface py-[9px] pr-[10px] pl-[17px] text-label text-inverse-on-surface shadow-[var(--shadow-3)] data-[type=error]:bg-error-container data-[type=error]:text-on-error-container',
          // 错误底是浅红，绿色的 inverse-primary 压在上面看不清：错误态换成同底的文字色并加下划线。
          actionButton:
            'ui-focus ml-auto cursor-pointer rounded-sm px-2 py-1 font-semibold whitespace-nowrap text-inverse-primary in-data-[type=error]:text-on-error-container in-data-[type=error]:underline in-data-[type=error]:underline-offset-3',
          closeButton: 'ui-focus cursor-pointer rounded-full',
        },
      }}
    />
  )
}
