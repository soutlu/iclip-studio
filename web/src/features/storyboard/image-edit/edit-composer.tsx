import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import type { SubmitPhase } from '@/shared/ui/button'
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
  insertAnnotation: (annotation: ImageAnnotation) => void
}

type EditComposerProps = {
  ref?: Ref<EditComposerHandle>
  baseUrl: string | undefined
  regenerate?: boolean
  frames: readonly EditFrame[]
  frameGroup: string
  aspectRatio: string
  annotations: readonly ImageAnnotation[]
  selectedAnnotation: string | null
  onSelectAnnotation: (id: string) => void
  initialParts: readonly EditDraftPart[]
  onPartsChange: (parts: EditDraftPart[]) => void
  onSubmit: (parts: EditDraftPart[]) => void
  phase: SubmitPhase
  settings: ReactNode
  editingResult: boolean
  submitBlocked?: boolean
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
  phase,
  ref,
  regenerate = false,
  selectedAnnotation,
  settings,
  submitBlocked = false,
}: EditComposerProps) {
  const composerRef = useRef<ComposerHandle<AnnotationNode>>(null)
  const { data: user } = useUser()
  const canUpload = hasPermission(user, PERMISSION.uploadsWrite)
  const [initial] = useState(initialParts)
  const [parts, setParts] = useState<readonly ComposerPart<AnnotationNode>[]>(() =>
    composerPartsOf(initialParts),
  )

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

  return (
    <AnnotationChipsProvider
      value={{ annotations, onSelect: onSelectAnnotation, selectedId: selectedAnnotation }}
    >
      <Composer<AnnotationNode, EditMentionItem>
        accept="image"
        accepted={phase === 'accepted'}
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
        onSubmit={(submission) => onSubmit(draftPartsOf(submission.parts))}
        placeholder={
          regenerate
            ? '描述想生成的内容，输入 @ 可引用图片'
            : editingResult
              ? '描述对该结果的修改要求，输入 @ 可引用图片或标注'
              : '描述修改要求，输入 @ 可引用图片或标注'
        }
        ref={composerRef}
        sending={phase === 'sending'}
        submitAction={{
          disabled: submitBlocked,
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
