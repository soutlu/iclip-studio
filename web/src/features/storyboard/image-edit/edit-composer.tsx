/** 图片编辑的输入卡：首页那张 composer 加上标注 chip、`@` 引用、「+」插帧、卡内拖放、只收图片与张数上限。
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
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import { AnnotationChipsProvider } from './annotation-chip'
import { annotationNodeSpec, annotationPart, type AnnotationNode } from './annotation-node'
import { EditAddPopover } from './edit-add-popover'
import { editMentionItems, type EditMentionItem } from './edit-mention-items'
import { EditMentionMenu } from './edit-mention-menu'
import { MAX_PART_NAME } from './image-edit-draft'
import type { EditDraftPart, ImageAnnotation } from './image-edit-types'

const NODES = [annotationNodeSpec]

/** 正文里的一张图片：就绪的按地址认，上传中的还没有地址，按条目认。失败的不算，它提交不了。 */
type ImageSlot = { key: string; url: string | undefined }

const imageSlotsOf = (parts: readonly ComposerPart<AnnotationNode>[]): ImageSlot[] =>
  parts.flatMap((part) =>
    part.kind === 'media' && part.media.status !== 'error'
      ? [{ key: part.media.url ?? part.media.attId, url: part.media.url }]
      : [],
  )

/** 草稿只存就绪的部分；去掉没就绪的图片后相邻的文字并成一段。 */
const draftPartsOf = (parts: readonly ComposerPart<AnnotationNode>[]): EditDraftPart[] => {
  const result: EditDraftPart[] = []
  const pushText = (text: string) => {
    const previous = result.at(-1)
    if (previous?.kind === 'text')
      result[result.length - 1] = { kind: 'text', text: previous.text + text }
    else result.push({ kind: 'text', text })
  }
  for (const part of parts) {
    if (part.kind === 'text') pushText(part.text)
    else if (part.kind === 'node') result.push({ kind: 'annotation', ...part.node.attrs })
    else if (part.media.status === 'ready' && part.media.url !== undefined)
      result.push({
        kind: 'image',
        name: part.media.name.slice(0, MAX_PART_NAME),
        url: part.media.url,
      })
  }
  return result
}

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
  frames: readonly string[]
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

  const frameName = (frame: number, url: string) =>
    url === baseUrl ? `帧 @${frame} · 编辑底图` : `帧 @${frame}`
  const partsOfItem = (item: EditMentionItem): ComposerPart<AnnotationNode>[] =>
    item.kind === 'base'
      ? [imagePart(item.url, '编辑底图')]
      : item.kind === 'annotation'
        ? [annotationPart(item.annotation)]
        : [imagePart(item.url, frameName(item.frame, item.url))]
  const itemBlockedReason = (item: EditMentionItem) =>
    item.kind === 'annotation' ? undefined : blockedReason(item.url)

  const mention: ComposerMention<EditMentionItem, AnnotationNode> = {
    items: (query) => editMentionItems({ annotations, baseUrl, frames, query }),
    partsOf: (item) => (itemBlockedReason(item) === undefined ? partsOfItem(item) : undefined),
    render: (menu) => <EditMentionMenu blockedReason={itemBlockedReason} menu={menu} />,
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
            onInsert={(frame) => {
              const url = frames[frame - 1]
              if (url !== undefined)
                composerRef.current?.insert([imagePart(url, frameName(frame, url))])
            }}
            onUpload={canUpload ? openFilePicker : undefined}
            ratio={ratio}
            referenced={referenced}
          />
        )}
        ariaLabel="修改要求"
        attachmentLimit={{
          notice: (dropped) => `${LIMIT_REASON}，这次有 ${dropped} 张没有添加`,
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
            ? '描述想生成什么，输入 @ 引用图片'
            : editingResult
              ? '描述想怎么改这张结果，输入 @ 引用图片或标注'
              : '描述想怎么改，输入 @ 引用图片或标注'
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
