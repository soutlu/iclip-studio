/** 编辑器的交互数据；引用用稳定 ID，编号仅作显示。HTTP 边界由生成合同校验。 */
export type AnnotationPoint = { x: number; y: number }
export type AnnotationKind = 'point' | 'rectangle' | 'ellipse' | 'arrow' | 'pen'
export type ImageAnnotation = {
  id: string
  number: number
  kind: AnnotationKind
  points: AnnotationPoint[]
}
/** 修改要求里的一段：文字、一张图（上传的、本组的帧或「编辑底图」，按地址认），或画布上的一个标注。
 * 标注带上建它时的编号：复制成文字与标注被删后的失效 chip 要用；提交时编号仍以画布上的为准。 */
export type EditDraftPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string; name: string }
  | { kind: 'annotation'; id: string; number: number }
/** 编辑器开在哪一张图上：分镜页是第几组的第几帧，制作页是工程里的一张图（`node`，用 `isFilmTarget` 区分）。
 * 底图不在里面：它随选中的图变，应用之后这一格的图也会变。 */
export type FrameEditTarget = StoryboardFrameTarget | { conversationId: string; node: string }
/** 分镜页的一格：第几组的第几帧。 */
export type StoryboardFrameTarget = {
  conversationId: string
  shotIndex: number
  frameNumber: number
}
/** 一张底图上没提交的输入：画布上的标注与修改要求。只存就绪的图片，上传中、失败的不进草稿。 */
export type FrameEditDraft = {
  annotations: ImageAnnotation[]
  parts: EditDraftPart[]
}
