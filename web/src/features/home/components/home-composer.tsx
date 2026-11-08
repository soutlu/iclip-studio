import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerHandle, ComposerPart, ComposerSubmission } from '@/shared/ui/composer'
import { Composer, readyAttachment } from '@/shared/ui/composer'

const PLACEHOLDER = '例如：给这双白色帆布鞋写一份 15 秒的产品分镜'
const SAME_STYLE_PLACEHOLDER = '参照该视频做同款，请输入要替换的内容'
const SAME_STYLE_PHRASES = [
  { label: '换人物', text: '把人物换成' },
  { label: '换产品', text: '把产品换成' },
  { label: '换场景', text: '把场景换成' },
] as const

export type HomeComposerProps = {
  agentPicker?: ReactNode
  attachmentsEnabled?: boolean | undefined
  collectionPicker?: ReactNode
  draftParts?: readonly ComposerPart[] | undefined
  onDraftChange?: ((parts: readonly ComposerPart[]) => void) | undefined
  focusRequested?: boolean | undefined
  onFocusHandled?: (() => void) | undefined
  onSend?: ((submission: ComposerSubmission) => Promise<boolean>) | undefined
  sameStyle?: boolean | undefined
  referenceUrl?: string | undefined
  onReferenceRemoved?: (() => void) | undefined
  sending?: boolean | undefined
}

export function HomeComposer({
  agentPicker,
  attachmentsEnabled = false,
  collectionPicker,
  draftParts,
  focusRequested = false,
  onDraftChange,
  onFocusHandled,
  onSend,
  sameStyle = false,
  referenceUrl,
  onReferenceRemoved,
  sending = false,
}: HomeComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const submittingRef = useRef(false)
  const [initialParts] = useState(draftParts)
  const partsRef = useRef<readonly ComposerPart[]>(initialParts ?? [])
  const referenceRef = useRef<{ url: string; attId: string } | null>(null)

  useEffect(() => {
    partsRef.current = initialParts ?? []
    referenceRef.current = null
    if (initialParts === undefined || initialParts.length === 0) return
    composerRef.current?.restore({
      media: initialParts.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
      parts: initialParts,
      text: '',
    })
  }, [initialParts])

  useEffect(() => {
    if (!focusRequested) return
    composerRef.current?.focus()
    onFocusHandled?.()
  }, [focusRequested, onFocusHandled])

  useEffect(() => {
    if (referenceUrl === referenceRef.current?.url) return
    const previous = referenceRef.current
    referenceRef.current = null
    if (previous !== null) composerRef.current?.removeAttachment(previous.attId)
    if (referenceUrl === undefined) return
    const existing = partsRef.current.find(
      (part) =>
        part.kind === 'media' && part.media.kind === 'video' && part.media.url === referenceUrl,
    )
    const media =
      existing?.kind === 'media'
        ? existing.media
        : readyAttachment({ kind: 'video', name: '参考视频', url: referenceUrl })
    referenceRef.current = { url: referenceUrl, attId: media.attId }
    if (existing === undefined) composerRef.current?.append([{ kind: 'media', media }])
    composerRef.current?.focus()
  }, [referenceUrl])

  const changeDraft = (parts: readonly ComposerPart[]) => {
    const reference = referenceRef.current
    const isReference = (part: ComposerPart) =>
      part.kind === 'media' && part.media.attId === reference?.attId
    const removed =
      reference !== null && partsRef.current.some(isReference) && !parts.some(isReference)
    partsRef.current = parts
    onDraftChange?.(parts)
    if (removed) {
      referenceRef.current = null
      onReferenceRemoved?.()
    }
  }

  const send = async (submission: ComposerSubmission) => {
    if (onSend === undefined || sending || submittingRef.current) return
    submittingRef.current = true
    try {
      if (await onSend(submission)) composerRef.current?.clear()
    } finally {
      submittingRef.current = false
    }
  }

  return (
    <div>
      <Composer
        attachmentsEnabled={attachmentsEnabled}
        leading={
          sameStyle ? (
            <div className="flex flex-wrap items-center gap-1.5 pl-1">
              {SAME_STYLE_PHRASES.map((phrase) => (
                <button
                  className="inline-flex h-(--control-height-xs) ui-state cursor-pointer items-center rounded-full border-[0.5px] border-chat-hairline px-2.5 text-body-sm whitespace-nowrap text-on-surface-variant ui-focus"
                  key={phrase.label}
                  onClick={() => {
                    composerRef.current?.insert([{ kind: 'text', text: phrase.text }])
                    composerRef.current?.focus()
                  }}
                  type="button"
                >
                  {phrase.label}
                </button>
              ))}
            </div>
          ) : undefined
        }
        onChange={changeDraft}
        onSubmit={(submission) => {
          void send(submission)
        }}
        placeholder={sameStyle ? SAME_STYLE_PLACEHOLDER : PLACEHOLDER}
        ref={composerRef}
        sending={sending}
        trailing={agentPicker}
      />
      {collectionPicker}
    </div>
  )
}
