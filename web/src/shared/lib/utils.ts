import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        'text-caption',
        'text-label',
        'text-body-sm',
        'text-ui',
        'text-body',
        'text-title',
        'text-title-lg',
        'text-headline',
        'text-headline-lg',
        'text-display-sm',
        'text-display',
      ],
      shadow: ['shadow-1', 'shadow-2', 'shadow-3', 'shadow-card', 'shadow-control-well'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
