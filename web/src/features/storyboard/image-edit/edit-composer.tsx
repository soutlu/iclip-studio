/** 图片编辑的输入卡：首页那张 composer 加上标注 chip、`@` 引用、「+」插本组图片、卡内拖放、只收图片与张数上限。
 *
 * 草稿按底图分份：挂载时（调用方按底图换 key）把这张底图的草稿装回来，之后每次变化只把就绪的部分写回。
 * 编辑底图与引用标注时的标注图是隐式提交的，不占 chip；上限 10 张里它固定占一张。 */

import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import {
  Composer,
  readyAttachment,
  type ComposerHandle,
  type ComposerMention,
  type ComposerPart,
} from '@/shared/ui/composer'
import { draftPartsOf, imageSlotsOf } from '../edit-prompt'
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import { AnnotationChipsProvider } from './annotation-chip'
import { annotationNodeSpec, annotationPart, type AnnotationNode } from './annotation-node'
import { EditAddPopover } from './edit-add-popover'
import { editMentionItems, type EditMentionItem } from './edit-mention-items'
import { EditMentionMenu } from './edit-mention-menu'
import type { EditDraftPart, EditFrame, ImageAnnotation } from './image-edit-types'

const NODES = [annotationNodeSpec]

const imagePart = (url: string, name: string): ComposerPart<AnnotationNode> => ({
  kind: 'media',
  media: readyAttachment({ kind: 'image', name, url }),
})

const composerPartsOf = (parts: readonly EditDraftPart[]): ComposerPart<AnnotationNode>[] =>
  parts.map((part) =>
    part.kind === 'text'
      ? part
      : part.kind === 'annotation'
        ? annotationPart(part)
        : imagePart(part.url, part.name),
  )

const LIMIT_REASON = `最多引用 ${MAX_EDIT_REFERENCES} 张图片`

export type EditComposerHandle = {
  /** 画布上点「引用」：把这个标注插到光标处。 */
  insertAnnotation: (annotation: ImageAnnotation) => void
}

type EditComposerProps = {
  ref?: Ref<EditComposerHandle>
  /** 编辑底图；按描述再生成（`regenerate`）没有底图，为 undefined，不占引用名额、`@` 里也没有它。 */
  baseUrl: string | undefined
  /** 按描述再生成：输入卡装的是这张图的描述，提交按钮叫「再生成」，没有模型设置。 */
  regenerate?: boolean
  /** `@` 与「+」能插的本组图片，下标加一是编号。 */
  frames: readonly EditFrame[]
  /** 它们的统称：分镜页叫帧，制作页叫图。 */
  frameGroup: string
  aspectRatio: string
  annotations: readonly ImageAnnotation[]
  selectedAnnotation: string | null
  onSelectAnnotation: (id: string) => void
  /** 这张底图的草稿，只在挂载时读。 */
  initialParts: readonly EditDraftPart[]
  onPartsChange: (parts: EditDraftPart[]) => void
  /** 终校、导出标注图与提交都归调用方；提交期间只让按钮转圈，输入不清空。 */
  onSubmit: (parts: EditDraftPart[]) => Promise<void>
  /** 模型、分辨率与渠道。 */
  settings: ReactNode
  /** 底图是一张还没替换上去的结果：舞台的主操作是「替换当前帧」，生成退为中性。 */
  editingResult: boolean
}

export function EditComposer({
  annotations,
  aspectRatio,
  baseUrl,
  editingResult,
  frameGroup,
  frames,
  initialParts,
  onPartsChange,
  onSelectAnnotation,
  onSubmit,
  ref,
  regenerate = false,
  selectedAnnotation,
  settings,
}: EditComposerProps) {
  const composerRef = useRef<ComposerHandle<AnnotationNode>>(null)
  const { data: user } = useUser()
  const canUpload = hasPermission(user, PERMISSION.uploadsWrite)
  const [initial] = useState(initialParts)
  const [parts, setParts] = useState<readonly ComposerPart<AnnotationNode>[]>(() =>
    composerPartsOf(initialParts),
  )
  const [sending, setSending] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    const restored = composerPartsOf(initial)
    composerRef.current?.restore({
      media: restored.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
      parts: restored,
      text: '',
    })
  }, [initial])

  useImperativeHandle(
    ref,
    () => ({
      insertAnnotation: (annotation) => composerRef.current?.insert([annotationPart(annotation)]),
    }),
    [],
  )

  const slots = imageSlotsOf(parts)
  const referenced = (url: string) => slots.some((slot) => slot.url === url)
  // 底图隐式提交、固定占一张；正文里指向底图的图片并进它，不另占。再生成没有底图。
  const remaining = () =>
    MAX_EDIT_REFERENCES -
    (baseUrl === undefined ? 0 : 1) -
    new Set(slots.filter((slot) => slot.url !== baseUrl).map((slot) => slot.key)).size
  const blockedReason = (url: string) =>
    url === baseUrl || referenced(url) || remaining() > 0 ? undefined : LIMIT_REASON
  const ratio = aspectValueOf(aspectRatio)

  const frameName = ({ name, url }: EditFrame) => (url === baseUrl ? `${name} · 编辑底图` : name)
  const partsOfItem = (item: EditMentionItem): ComposerPart<AnnotationNode>[] =>
    item.kind === 'base'
      ? [imagePart(item.url, '编辑底图')]
      : item.kind === 'annotation'
        ? [annotationPart(item.annotation)]
        : [imagePart(item.url, frameName(item))]
  const itemBlockedReason = (item: EditMentionItem) =>
    item.kind === 'annotation' ? undefined : blockedReason(item.url)

  const mention: ComposerMention<EditMentionItem, AnnotationNode> = {
    items: (query) => editMentionItems({ annotations, baseUrl, frames, query }),
    partsOf: (item) => (itemBlockedReason(item) === undefined ? partsOfItem(item) : undefined),
    render: (menu) => (
      <EditMentionMenu blockedReason={itemBlockedReason} frames={frameGroup} menu={menu} />
    ),
  }

  const submit = async (submitted: readonly ComposerPart<AnnotationNode>[]) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSending(true)
    try {
      await onSubmit(draftPartsOf(submitted))
    } finally {
      submittingRef.current = false
      setSending(false)
    }
  }

  return (
    <AnnotationChipsProvider
      value={{ annotations, onSelect: onSelectAnnotation, selectedId: selectedAnnotation }}
    >
      <Composer<AnnotationNode, EditMentionItem>
        accept="image"
        addControl={(openFilePicker) => (
          <EditAddPopover
            blockedReason={blockedReason}
            frames={frames}
            group={frameGroup}
            onInsert={(frame) => {
              const item = frames[frame - 1]
              if (item !== undefined)
                composerRef.current?.insert([imagePart(item.url, frameName(item))])
            }}
            onUpload={canUpload ? openFilePicker : undefined}
            ratio={ratio}
            referenced={referenced}
          />
        )}
        ariaLabel="修改要求"
        attachmentLimit={{
          notice: (dropped) => `${LIMIT_REASON}，本次有 ${dropped} 张未添加`,
          remaining,
        }}
        attachmentsEnabled={canUpload}
        className="image-edit-composer"
        dropScope="card"
        mention={mention}
        nodes={NODES}
        onChange={(next) => {
          setParts(next)
          onPartsChange(draftPartsOf(next))
        }}
        onSubmit={(submission) => void submit(submission.parts)}
        placeholder={
          regenerate
            ? '描述想生成的内容，输入 @ 可引用图片'
            : editingResult
              ? '描述对该结果的修改要求，输入 @ 可引用图片或标注'
              : '描述修改要求，输入 @ 可引用图片或标注'
        }
        ref={composerRef}
        sending={sending}
        submitAction={{
          emphasis: editingResult ? 'neutral' : 'primary',
          icon: 'image',
          label: regenerate ? '再生成' : '生成图片',
          pendingLabel: '提交中…',
        }}
        trailing={settings}
      />
    </AnnotationChipsProvider>
  )
}
