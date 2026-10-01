/** 正文里的帧引用节点：节点存编号与原文记号（`@Image01` 这类写法原样往返），渲染交给 FrameChip。 */

import type { ComposerNodeSpec, ComposerPart } from '@/shared/ui/composer'
import { FrameChip } from './frame-chip'

export type FrameNode = { name: 'frame'; attrs: { n: number; token: string } }

/** 新插入的第 `n` 帧引用，记号用规范写法 `@ImageN`。 */
export const framePart = (n: number): ComposerPart<FrameNode> => ({
  kind: 'node',
  node: { attrs: { n, token: `@Image${n}` }, name: 'frame' },
})

export const frameNodeSpec: ComposerNodeSpec<FrameNode> = {
  attrNames: ['n', 'token'],
  leafText: (node) => node.attrs.token,
  name: 'frame',
  render: (node) => <FrameChip n={node.attrs.n} />,
  // 芯片自己响应点击与 Enter / 空格（看这一帧，同 FrameChip 的 onKeyDown）：编辑器不把它们当成选中节点或分段。
  stopEvent: (event) =>
    event.type === 'click' ||
    event.type === 'mousedown' ||
    (event instanceof KeyboardEvent &&
      event.type === 'keydown' &&
      (event.key === 'Enter' || event.key === ' ')),
}

/** 编辑器的节点表：模块级常量，schema 按它建一次。 */
export const FRAME_NODES = [frameNodeSpec]
