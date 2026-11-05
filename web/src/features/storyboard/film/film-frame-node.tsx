import type { ComposerNodeSpec, ComposerPart } from '@/shared/ui/composer'
import { frameNodeSpec, type FrameNode } from '../components/frame-node'
import { createPromptDoc } from '../components/prompt-editor-doc'
import { FILM_TOKEN, newImageToken } from './film-draft-text'
import { FilmFrameChip } from './film-frame-chip'

const filmFrameNodeSpec: ComposerNodeSpec<FrameNode> = {
  ...frameNodeSpec,
  render: (node) => <FilmFrameChip n={node.attrs.n} token={node.attrs.token} />,
}

export const FILM_FRAME_NODES = [filmFrameNodeSpec]

export const filmPromptDoc = createPromptDoc(FILM_FRAME_NODES, FILM_TOKEN)

export const newImagePart = (url: string): ComposerPart<FrameNode> => ({
  kind: 'node',
  node: { attrs: { n: 0, token: newImageToken(url) }, name: 'frame' },
})
