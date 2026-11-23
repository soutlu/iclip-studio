import type { ComponentPropsWithoutRef } from 'react'

export function BusyRing(props: Omit<ComponentPropsWithoutRef<'span'>, 'className' | 'children'>) {
  return <span aria-hidden className="busy-ring" {...props} />
}
