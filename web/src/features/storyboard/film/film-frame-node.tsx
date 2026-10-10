/** 制作页正文里的 `@ImageN` 节点：与分镜页同一个帧节点（`frameNodeSpec`，原文记号原样往返），芯片换成制作页的
 * `FilmFrameChip`；正文与文档的互转与分镜页同一套（`createPromptDoc`），按这张节点表另建一份。 */

import type { ComposerNodeSpec } from '@/shared/ui/composer'
import { frameNodeSpec, type FrameNode } from '../components/frame-node'
import { createPromptDoc } from '../components/prompt-editor-doc'
import { FilmFrameChip } from './film-frame-chip'

const filmFrameNodeSpec: ComposerNodeSpec<FrameNode> = {
  ...frameNodeSpec,
  render: (node) => <FilmFrameChip n={node.attrs.n} />,
}

/** 编辑器的节点表：模块级常量，schema 按它建一次。 */
export const FILM_FRAME_NODES = [filmFrameNodeSpec]

export const filmPromptDoc = createPromptDoc(FILM_FRAME_NODES)
