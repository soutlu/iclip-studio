import type { ComposerNodeSpec, ComposerPart } from '@/shared/ui/composer'
import { FrameChip } from './frame-chip'

export type FrameNode = { name: 'frame'; attrs: { n: number; token: string } }

export const framePart = (n: number): ComposerPart<FrameNode> => ({
  kind: 'node',
  node: { attrs: { n, token: `@Image${n}` }, name: 'frame' },
})

export const frameNodeSpec: ComposerNodeSpec<FrameNode> = {
  attrNames: ['n', 'token'],
  leafText: (node) => node.attrs.token,
  name: 'frame',
  render: (node) => <FrameChip n={node.attrs.n} />,
  stopEvent: (event) =>
    event.type === 'click' ||
    event.type === 'mousedown' ||
    (event instanceof KeyboardEvent &&
      event.type === 'keydown' &&
      (event.key === 'Enter' || event.key === ' ')),
}

export const FRAME_NODES = [frameNodeSpec]
