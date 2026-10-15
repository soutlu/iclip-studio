/** 编辑器舞台的模糊底，图片编辑与视频编辑共用；样式见 storyboard.css「编辑器舞台共用」一节。 */

import { useState } from 'react'
import { cn } from '@/shared/lib/utils'

/** 舞台底：舞台上那张图（视频是海报）放大、模糊，压一层底色，画面两侧不留空。
 * 新图加载成功后才淡入；连续换图或装饰图加载失败时保留上一张已加载的图。
 * 没有图时立即清空，露出舞台底色，不留上一来源的画面。
 * 放在舞台里的第一层，舞台自己负责圆角裁切。 */
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
                  // 切回仍挂在底层的缓存图片时不会再触发 load；同样认浏览器已解码的结果。
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
