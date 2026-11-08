export type AnnotationPoint = { x: number; y: number }
export type AnnotationKind = 'point' | 'rectangle' | 'ellipse' | 'arrow' | 'pen'
export type ImageAnnotation = {
  id: string
  number: number
  kind: AnnotationKind
  points: AnnotationPoint[]
}
export type EditDraftPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string; name: string }
  | { kind: 'annotation'; id: string; number: number }
export type EditFrame = { url: string; name: string; number?: number }
export type FrameEditTarget = StoryboardFrameTarget | { conversationId: string; node: string }
export type StoryboardFrameTarget = {
  conversationId: string
  shotIndex: number
  frameNumber: number
}
export type FrameEditDraft = {
  annotations: ImageAnnotation[]
  parts: EditDraftPart[]
}
