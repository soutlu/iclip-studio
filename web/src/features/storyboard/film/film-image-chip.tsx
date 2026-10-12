/** 制作页的一张图：缩略图加 @N（还没有编号的写它的名字），外观同分镜页的帧芯片（storyboard.css「帧芯片」）。
 * 有图的悬停出预览卡（与输入框里的图片 chip 同一张卡），卡上「放大」开灯箱；还没有图的画一格空位，悬停出提示写
 * 「@N 名字」，有说明（`note`，如「未选用」）时接「 · 未选用」，芯片上就是名字又没有说明的不出提示。
 * 能点的（正文与参考图里）点了让舞台看它，舞台正在看它时实色高亮；生图描述里的只看不点。 */

import { useEffect, useState } from 'react'
import { MediaPreviewCard, useHoverPreview } from '@/shared/ui/media-preview'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type FilmImageChipProps = {
  /** 给人看的名字：预览卡与没图时的提示用它，读屏念它加 `tag`。 */
  label: string
  /** 芯片上的字：@N 或名字。 */
  tag: string
  url: string | null
  highlighted?: boolean
  /** 这张图的一句说明，如「未选用」；读屏一起念，没图时写进悬停提示，芯片上不显示。 */
  note?: string | undefined
  /** 点芯片；不给就不能点。 */
  onPick?: (() => void) | undefined
  onEnlarge: (url: string) => void
}

export function FilmImageChip({
  highlighted = false,
  label,
  note,
  onEnlarge,
  onPick,
  tag,
  url,
}: FilmImageChipProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const tip = useHoverPreview()
  const { close, onEnter, onLeave } = tip
  // 锚点与预览卡共用进入、离开的时序；没有图就没有预览。
  useEffect(() => {
    if (anchor === null || url === null) return undefined
    anchor.addEventListener('mouseenter', onEnter)
    anchor.addEventListener('mouseleave', onLeave)
    return () => {
      anchor.removeEventListener('mouseenter', onEnter)
      anchor.removeEventListener('mouseleave', onLeave)
    }
  }, [anchor, onEnter, onLeave, url])

  // 读屏念名字加芯片上的字，同一元素的几张图才分得开；还没有编号时芯片上就是名字，只念一次。
  const spoken = `${tag === label ? label : `${label} ${tag}`}${note === undefined ? '' : `，${note}`}`
  // 没图时悬停补上芯片上看不到的名字与说明；芯片上就是名字又没有说明时没什么可补。
  const named = tag === label ? label : `${tag} ${label}`
  const hint =
    url !== null || (tag === label && note === undefined)
      ? undefined
      : `${named}${note === undefined ? '' : ` · ${note}`}`
  const pill = (
    <span className="frame-chip-pill ui-motion-s">
      {url === null ? <span className="film-chip-empty" /> : <img alt="" src={url} />}
      <span>{tag}</span>
    </span>
  )
  const chip =
    onPick === undefined ? (
      <span aria-label={spoken} className="frame-chip film-chip" ref={setAnchor} role="img">
        {pill}
      </span>
    ) : (
      <button
        aria-label={`在舞台查看${spoken}`}
        className="frame-chip film-chip ui-focus"
        data-highlighted={highlighted ? '' : undefined}
        onClick={onPick}
        // 点芯片自己选段与图：焦点不再冒到段卡上先选一次段，免得舞台跳两次。
        onFocus={(event) => event.stopPropagation()}
        ref={setAnchor}
        type="button"
      >
        {pill}
      </button>
    )
  return (
    <>
      {hint === undefined ? (
        chip
      ) : (
        <TooltipRoot>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </TooltipRoot>
      )}
      {tip.open && anchor !== null && url !== null ? (
        <MediaPreviewCard
          anchorEl={anchor}
          media={{ kind: 'image', name: label, previewUrl: url }}
          onEnlarge={() => {
            close()
            onEnlarge(url)
          }}
          onEnter={onEnter}
          onLeave={onLeave}
        />
      ) : null}
    </>
  )
}
