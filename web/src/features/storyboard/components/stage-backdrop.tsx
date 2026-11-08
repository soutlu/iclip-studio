import { useState } from 'react'
import { cn } from '@/shared/lib/utils'

export function StageBackdrop({ url }: { url: string | undefined }) {
  const [loaded, setLoaded] = useState<{
    current: string | undefined
    previous: string | undefined
  }>({ current: undefined, previous: undefined })
  if (url === undefined && loaded.current !== undefined)
    setLoaded({ current: undefined, previous: undefined })
  const previous = loaded.current === url ? loaded.previous : loaded.current
  const ready = () => {
    if (url !== undefined)
      setLoaded((last) => (last.current === url ? last : { current: url, previous: last.current }))
  }
  const layers = url === undefined ? [] : previous === undefined ? [url] : [previous, url]
  return (
    <div aria-hidden="true" className="stage-backdrop">
      {layers.map((layer) => (
        <img
          alt=""
          className={cn(
            'stage-backdrop-image',
            layer === url &&
              loaded.current === url &&
              'animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none',
          )}
          draggable={false}
          hidden={layer === url && loaded.current !== url}
          key={layer}
          onLoad={layer === url ? ready : undefined}
          ref={
            layer === url
              ? (image) => {
                  if (image?.complete === true && image.naturalWidth > 0) ready()
                }
              : undefined
          }
          src={layer}
        />
      ))}
      <span className="stage-backdrop-veil" />
    </div>
  )
}
