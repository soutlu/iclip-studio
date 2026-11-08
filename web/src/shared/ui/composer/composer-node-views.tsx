import { createPortal } from 'react-dom'
import { ComposerAttachmentPill, type ComposerAttachmentPreview } from './composer-attachment-pill'
import type { ComposerAttachment, ComposerAttachments } from './use-composer-attachments'
import type { ComposerEditor } from './use-composer-editor'

export type ComposerAttachmentPreviewOf = (
  attachment: ComposerAttachment,
) => ComposerAttachmentPreview | undefined

type ComposerNodeViewsProps = {
  editor: ComposerEditor
  attachments: ComposerAttachments
  layerContainer: HTMLElement | null
  attachmentPreview?: ComposerAttachmentPreviewOf | undefined
}

export function ComposerNodeViews({
  attachmentPreview,
  attachments,
  editor,
  layerContainer,
}: ComposerNodeViewsProps) {
  const { failureCard, hosts, setFailureCard, specOf } = editor.nodeViews
  const previewOf = (entry: ComposerAttachment | undefined) =>
    entry === undefined ? undefined : attachmentPreview?.(entry)
  return hosts.map((host) =>
    host.type === 'attachment'
      ? createPortal(
          <ComposerAttachmentPill
            entry={attachments.entries.get(host.attId)}
            failureCardOpen={failureCard?.attId === host.attId}
            failureCardTakesFocus={failureCard?.takeFocus === true}
            focusEditor={editor.focusEditor}
            hostEl={host.el}
            kind={host.kind}
            layerContainer={layerContainer}
            name={host.name}
            onFailureCardOpenChange={(open) =>
              setFailureCard(open ? { attId: host.attId, takeFocus: false } : null)
            }
            onRemove={() => {
              setFailureCard(null)
              editor.removeAttachment(host.attId)
            }}
            onRetry={() => {
              setFailureCard(null)
              attachments.retry(host.attId)
            }}
            preview={previewOf(attachments.entries.get(host.attId))}
          />,
          host.el,
          host.key,
        )
      : createPortal(specOf(host.node.name)?.render(host.node), host.el, host.key),
  )
}
