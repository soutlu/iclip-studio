/** 制作页正文里的图片节点：与分镜页同一个帧节点（`frameNodeSpec`，原文记号原样往返），芯片换成制作页的
 * `FilmFrameChip`；正文与文档的互转与分镜页同一套（`createPromptDoc`），按这张节点表另建一份，另认新插入的图的记号
 * （编号记 0，记号里是地址，见 `film-draft-text`）。 */

import type { ComposerNodeSpec, ComposerPart } from '@/shared/ui/composer'
import { frameNodeSpec, type FrameNode } from '../components/frame-node'
import { createPromptDoc } from '../components/prompt-editor-doc'
import { FILM_TOKEN, newImageToken } from './film-draft-text'
import { FilmFrameChip } from './film-frame-chip'

const filmFrameNodeSpec: ComposerNodeSpec<FrameNode> = {
  ...frameNodeSpec,
  render: (node) => <FilmFrameChip n={node.attrs.n} token={node.attrs.token} />,
}

/** 编辑器的节点表：模块级常量，schema 按它建一次。 */
export const FILM_FRAME_NODES = [filmFrameNodeSpec]

export const filmPromptDoc = createPromptDoc(FILM_FRAME_NODES, FILM_TOKEN)

/** 新插入的一张图：还没有编号，保存后按后端给的编号显示。 */
export const newImagePart = (url: string): ComposerPart<FrameNode> => ({
  kind: 'node',
  node: { attrs: { n: 0, token: newImageToken(url) }, name: 'frame' },
})
