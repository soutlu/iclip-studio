import { useCallback, useState } from 'react'

export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ height: 0, width: 0 })
  const ref = useCallback((element: T | null) => {
    if (element === null) return
    const measure = () => {
      const { height, width } = element.getBoundingClientRect()
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { height, width },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}
