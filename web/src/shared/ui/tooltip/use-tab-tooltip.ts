import { useState, type FocusEvent, type KeyboardEvent } from 'react'

export const useTabTooltip = () => {
  const [open, setOpen] = useState(false)
  return {
    rootProps: { onOpenChange: setOpen, open },
    triggerProps: {
      onFocus: (event: FocusEvent) => event.preventDefault(),
      onKeyUp: (event: KeyboardEvent) => {
        if (event.key === 'Tab') setOpen(true)
      },
    },
  }
}
