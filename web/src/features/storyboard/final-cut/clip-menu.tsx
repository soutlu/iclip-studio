import type { ReactNode } from 'react'
import { ContextMenuItem, ContextMenuSeparator } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { SPLIT_REFUSAL_TEXT, type Cut, type SplitPlan } from './clip-edit'
import type { FilmClip, VideoClip } from './composition/film'
import { SPLIT_LABEL } from './editor-toolbar'
import { originalSoundBlocked, originalSoundChanges, type AttributeChanges } from './original-sound'

type ClipMenuItemsProps = {
  /** 点右键的那个片段。 */
  clip: FilmClip
  /** 在播放头处切开这个片段的打算。 */
  split: SplitPlan
  /** 切开，和按 S 一样。 */
  onSplit: (cuts: readonly Cut[]) => void
  /** 视频片段的素材确认没有声音。 */
  silent: boolean
  /** 隐藏或显示一个片段（音频片段就是静音），和「属性」头部的开关一样。 */
  onHide: (id: string, hidden: boolean) => void
  /** 改片段上的几个属性，和「属性」里的控件一样。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
}

/**
 * 时间线上片段右键菜单里的几项。切开、静音、隐藏只改点右键的这一个片段：视频片段的静音是「属性」里的
 * 「关闭原声」，音频片段的静音和画面区片段的隐藏是「属性」头部的开关；删除和按 Delete 一样删掉选中的全部片段。
 */
export function ClipMenuItems({
  clip,
  split,
  onSplit,
  silent,
  onHide,
  onAttributes,
  onRemove,
}: ClipMenuItemsProps) {
  const toggleHidden = () => onHide(clip.id, !clip.hidden)
  return (
    <>
      {'cuts' in split ? (
        <ContextMenuItem onSelect={() => onSplit(split.cuts)} shortcut={['S']}>
          {SPLIT_LABEL}
        </ContextMenuItem>
      ) : (
        <BlockedItem reason={SPLIT_REFUSAL_TEXT[split.refusal]} shortcut={['S']}>
          {SPLIT_LABEL}
        </BlockedItem>
      )}
      <ContextMenuSeparator />
      {clip.kind === 'video' ? (
        <VideoMuteItem clip={clip} onAttributes={onAttributes} silent={silent} />
      ) : clip.kind === 'audio' ? (
        <ContextMenuItem onSelect={toggleHidden}>
          {clip.hidden ? '取消静音' : '静音此片段'}
        </ContextMenuItem>
      ) : null}
      {clip.kind === 'audio' ? null : (
        <ContextMenuItem onSelect={toggleHidden}>
          {clip.hidden ? '恢复显示画面' : '隐藏片段画面'}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem destructive onSelect={onRemove} shortcut={['Delete']}>
        删除片段
      </ContextMenuItem>
    </>
  )
}

/** 被拦下的一项：置灰、仍能聚焦，悬停或聚焦时说明原因，选它不做事、菜单不关。 */
function BlockedItem({
  reason,
  shortcut,
  children,
}: {
  reason: string
  shortcut?: readonly string[]
  children: ReactNode
}) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <ContextMenuItem
          aria-disabled
          onSelect={(event) => event.preventDefault()}
          shortcut={shortcut}
        >
          {children}
        </ContextMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right">{reason}</TooltipContent>
    </TooltipRoot>
  )
}

/** 视频片段的静音，就是「关闭原声」。和那个开关一样，素材没有声音时打开原声被拦下。 */
function VideoMuteItem({
  clip,
  silent,
  onAttributes,
}: Pick<ClipMenuItemsProps, 'silent' | 'onAttributes'> & { clip: VideoClip }) {
  const label = clip.muted ? '取消静音' : '静音此片段'
  const blocked = originalSoundBlocked(clip, silent)
  if (blocked === undefined)
    return (
      <ContextMenuItem onSelect={() => onAttributes(clip.id, originalSoundChanges(!clip.muted))}>
        {label}
      </ContextMenuItem>
    )
  return <BlockedItem reason={blocked}>{label}</BlockedItem>
}
