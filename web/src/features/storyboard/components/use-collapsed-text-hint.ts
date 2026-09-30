/** 舞台操作行带字按钮的名字提示：文字露着时不提示，文字被容器查询收起、退成图标时才在悬停或聚焦时说出名字。 */

import { useState } from 'react'

/** `bindText` 作为可见文字 span 的 ref，`tooltip` 交给提示的受控开合；收起与否读样式算出的结果，阈值只在 CSS。 */
export const useCollapsedTextHint = () => {
  const [text, setText] = useState<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  return {
    bindText: setText,
    tooltip: {
      open,
      onOpenChange: (next: boolean) => setOpen(next && textHidden(text)),
    },
  }
}

const textHidden = (text: HTMLElement | null) =>
  text !== null && getComputedStyle(text).display === 'none'
