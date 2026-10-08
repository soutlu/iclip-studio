/** 编辑器舞台的模糊底，图片编辑与视频编辑共用；样式见 storyboard.css「编辑器舞台共用」一节。 */

import { useState } from 'react'
import { cn } from '@/shared/lib/utils'

/** 舞台底：舞台上那张图（视频是海报）放大、模糊，压一层底色，画面两侧不留空。
 * 换图时新的一层淡入、盖住旧的，不闪；没有图时清空，露出舞台底色，不留上一张的画面。
 * 放在舞台里的第一层，舞台自己负责圆角裁切。 */
export function StageBackdrop({ url }: { url: string | undefined }) {
  const [layers, setLayers] = useState<readonly string[]>(url === undefined ? [] : [url])
  const last = layers.at(-1)
  if (last !== url) setLayers(url === undefined ? [] : last === undefined ? [url] : [last, url])
  return (
    <div aria-hidden="true" className="stage-backdrop">
      {layers.map((layer, at) => (
        <img
          alt=""
          className={cn(
            'stage-backdrop-image',
            at === layers.length - 1 &&
              'animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none',
          )}
          draggable={false}
          key={layer}
          src={layer}
        />
      ))}
      <span className="stage-backdrop-veil" />
    </div>
  )
}
