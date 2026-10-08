/** 修改要求里敲 `@` 的菜单：按「编辑底图 / 标注 / 本组图片」分组列出能引用的东西，`@` 之后的字按名称筛选。
 *
 * 焦点始终留在编辑器里：选项不可聚焦、按下不抢焦点，键盘由编辑器转过来；`active` 是键盘停在的项。 */

import { useId } from 'react'
import type { ComposerMentionMenu } from '@/shared/ui/composer'
import { cn } from '@/shared/lib/utils'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { mentionLabelOf, type EditMentionItem } from './edit-mention-items'

const groupLabelOf = (kind: EditMentionItem['kind'], frames: string) =>
  kind === 'annotation' ? '标注' : kind === 'base' ? '编辑底图' : frames

const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault()

/** 相邻同类的项归成一组；`index` 是它在整张列表里的位置，也就是键盘与选中用的序号。 */
const groupsOf = (items: readonly EditMentionItem[]) => {
  const groups: {
    kind: EditMentionItem['kind']
    entries: { index: number; item: EditMentionItem }[]
  }[] = []
  items.forEach((item, index) => {
    const last = groups.at(-1)
    if (last?.kind === item.kind) last.entries.push({ index, item })
    else groups.push({ entries: [{ index, item }], kind: item.kind })
  })
  return groups
}

type EditMentionMenuProps = {
  menu: ComposerMentionMenu<EditMentionItem>
  /** 本组图片那一组的标题：分镜页叫帧，制作页叫图。 */
  frames: string
  /** 这一项此刻不能选（图片已到上限）时给出原因。 */
  blockedReason: (item: EditMentionItem) => string | undefined
}

export function EditMentionMenu({ blockedReason, frames, menu }: EditMentionMenuProps) {
  const { active, anchor, items, listRef, onClose, onPick } = menu
  const menuId = useId()
  return (
    <PopupRoot onOpenChange={(open) => !open && onClose()} open>
      <PopupAnchor virtualRef={anchor} />
      <PopupSurface
        align="start"
        aria-label="引用图片或标注"
        className="max-h-[min(20rem,var(--radix-popover-content-available-height))] w-64 max-w-[calc(100vw-32px)] overflow-y-auto overscroll-contain p-1"
        collisionPadding={12}
        onCloseAutoFocus={keepEditorFocus}
        onOpenAutoFocus={keepEditorFocus}
        side="bottom"
        sideOffset={4}
      >
        {items.length === 0 ? (
          <p className="px-2.5 py-2 text-body-sm text-on-surface-muted">暂无匹配的图片或标注</p>
        ) : null}
        <ul aria-label="引用图片或标注" ref={listRef} role="listbox">
          {groupsOf(items).map(({ kind, entries }) => (
            <li aria-labelledby={`${menuId}-${kind}`} key={kind} role="group">
              <p
                className="px-2.5 pt-1.5 pb-1 text-caption text-on-surface-muted"
                id={`${menuId}-${kind}`}
              >
                {groupLabelOf(kind, frames)}
              </p>
              <ul role="presentation">
                {entries.map(({ index, item }) => {
                  const label = mentionLabelOf(item)
                  const blocked = blockedReason(item)
                  return (
                    <li key={index} role="presentation">
                      <button
                        aria-disabled={blocked === undefined ? undefined : true}
                        aria-selected={index === active}
                        className={cn(
                          'flex h-9 w-full ui-state cursor-pointer items-center gap-2 rounded-sm px-2.5 text-left text-body-sm text-on-surface',
                          'aria-disabled:cursor-not-allowed aria-disabled:text-on-surface-faint aria-selected:bg-state-active',
                        )}
                        onClick={() => onPick(index)}
                        onPointerDown={keepEditorFocus}
                        role="option"
                        tabIndex={-1}
                        title={blocked}
                        type="button"
                      >
                        {item.kind === 'annotation' ? (
                          <span aria-hidden className="annotation-chip-number">
                            {item.annotation.number}
                          </span>
                        ) : (
                          <img
                            alt=""
                            className="size-6 shrink-0 rounded-xs bg-surface-container object-cover"
                            src={item.url}
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {blocked === undefined ? null : (
                          <span className="shrink-0 text-caption">已达上限</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      </PopupSurface>
    </PopupRoot>
  )
}
