import type { ReactNode } from 'react'
import { ContextMenuItem, ContextMenuSeparator } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { SPLIT_REFUSAL_TEXT, type Cut, type SplitPlan } from './clip-edit'
import type { FilmClip, VideoClip } from './composition/film'
import { SPLIT_LABEL } from './editor-toolbar'
import { originalSoundBlocked, originalSoundChanges, type AttributeChanges } from './original-sound'
import {
  MERGE_LABEL,
  offsetText,
  resyncPlan,
  type SoundAction,
  type SoundControls,
} from './sound-pair'

type ClipMenuItemsProps = {
  /** 点右键的那个片段。 */
  clip: FilmClip
  /** final-cut 里所有的片段：对齐口型时按它们找落点。 */
  clips: readonly FilmClip[]
  /** 在播放头处切开这个片段的打算。 */
  split: SplitPlan
  /** 切开，和按 S 一样。 */
  onSplit: (cuts: readonly Cut[]) => void
  /** 这个片段上的「分离音频」钮做什么。 */
  sound: SoundAction
  /** 分离、合并、联动、对齐口型、选中另一段。 */
  controls: SoundControls
  /** 视频片段的素材确认没有声音。 */
  silent: boolean
  /** 隐藏或显示一个片段（音频片段就是静音），和「属性」头部的开关一样。 */
  onHide: (id: string, hidden: boolean) => void
  /** 改片段上的几个属性，和「属性」里的控件一样。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
}

const SOUND_KEYS = ['⇧⌘B']

/**
 * 时间线上片段右键菜单里的几项。切开、分离音频、静音、隐藏只改点右键的这一个片段：视频片段的静音是「属性」里的
 * 「关闭原声」，音频片段的静音和画面区片段的隐藏是「属性」头部的开关；删除和按 Delete 一样删掉选中的全部片段。
 * 已分离的一对里的片段换成选中另一段、联动开关、对齐口型（错开时）和合并回视频；分离过原声的视频片段不再有静音。
 * 字幕不能切开、分离、静音，也不能单句隐藏，只有「删除字幕」。
 */
export function ClipMenuItems({
  clip,
  clips,
  split,
  onSplit,
  sound,
  controls,
  silent,
  onHide,
  onAttributes,
  onRemove,
}: ClipMenuItemsProps) {
  if (clip.kind === 'caption') return <RemoveItem onRemove={onRemove}>删除字幕</RemoveItem>
  const toggleHidden = () => onHide(clip.id, !clip.hidden)
  const paired = sound.kind === 'merge'
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
      {sound.kind === 'none' ? null : <ContextMenuSeparator />}
      {sound.kind === 'detach' ? (
        <CommandItem
          blocked={sound.blocked}
          onSelect={() => controls.run(sound)}
          shortcut={SOUND_KEYS}
        >
          分离音频至独立音轨
        </CommandItem>
      ) : null}
      {sound.kind === 'merge' ? (
        <PairItems clip={clip} clips={clips} controls={controls} sound={sound} />
      ) : null}
      <ContextMenuSeparator />
      {clip.kind === 'video' && !paired ? (
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
      <RemoveItem onRemove={onRemove}>删除片段</RemoveItem>
    </>
  )
}

/** 删除选中的片段，和按 Delete 一样。 */
function RemoveItem({ onRemove, children }: { onRemove: () => void; children: ReactNode }) {
  return (
    <ContextMenuItem destructive onSelect={onRemove} shortcut={['Delete']}>
      {children}
    </ContextMenuItem>
  )
}

/** 已分离的一对里的片段：选中另一段、联动开关、对齐口型（错开时）、合并回视频。 */
function PairItems({
  clip,
  clips,
  sound,
  controls,
}: {
  clip: FilmClip
  clips: readonly FilmClip[]
  sound: Extract<SoundAction, { kind: 'merge' }>
  controls: SoundControls
}) {
  const { pair } = sound
  const other = clip.id === pair.audio.id ? pair.video : pair.audio
  const plan = resyncPlan(pair, clips)
  return (
    <>
      <ContextMenuItem onSelect={() => controls.locate(other.id)}>
        {other.kind === 'video' ? '选中关联的视频片段' : '选中分离的原声片段'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => controls.link(pair, !pair.linked)}>
        {pair.linked ? '解除与画面的联动' : '开启与画面同步联动'}
      </ContextMenuItem>
      {pair.offsetMs === 0 ? null : (
        <CommandItem
          blocked={'refusal' in plan ? plan.refusal : undefined}
          onSelect={() => controls.resync(pair)}
        >
          对齐口型与画面{pair.offsetMs === null ? '' : `（${offsetText(pair.offsetMs)}）`}
        </CommandItem>
      )}
      <CommandItem
        blocked={sound.blocked}
        onSelect={() => controls.run(sound)}
        shortcut={SOUND_KEYS}
      >
        {MERGE_LABEL}
      </CommandItem>
    </>
  )
}

/** 能做时是普通的一项，被拦下时是 `BlockedItem`。 */
function CommandItem({
  blocked,
  onSelect,
  shortcut,
  children,
}: {
  blocked: string | undefined
  onSelect: () => void
  shortcut?: readonly string[]
  children: ReactNode
}) {
  if (blocked !== undefined)
    return (
      <BlockedItem reason={blocked} shortcut={shortcut}>
        {children}
      </BlockedItem>
    )
  return (
    <ContextMenuItem onSelect={onSelect} shortcut={shortcut}>
      {children}
    </ContextMenuItem>
  )
}

/** 被拦下的一项：置灰、仍能聚焦，悬停或聚焦时说明原因，选它不做事、菜单不关。 */
function BlockedItem({
  reason,
  shortcut,
  children,
}: {
  reason: string
  shortcut?: readonly string[] | undefined
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
