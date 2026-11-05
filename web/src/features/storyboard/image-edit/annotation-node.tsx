import type { ComposerNodeSpec, ComposerPart } from '@/shared/ui/composer'
import { AnnotationChip } from './annotation-chip'

export type AnnotationNode = { name: 'annotation'; attrs: { id: string; number: number } }

export const annotationPart = (annotation: {
  id: string
  number: number
}): ComposerPart<AnnotationNode> => ({
  kind: 'node',
  node: { attrs: { id: annotation.id, number: annotation.number }, name: 'annotation' },
})

export const annotationNodeSpec: ComposerNodeSpec<AnnotationNode> = {
  attrNames: ['id', 'number'],
  leafText: (node) => `标注 ${node.attrs.number}`,
  name: 'annotation',
  render: (node) => <AnnotationChip node={node} />,
}
