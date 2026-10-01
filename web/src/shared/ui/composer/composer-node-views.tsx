/** 编辑核心建的 NodeView 宿主里的 React 内容：附件 chip（上传态、悬停预览、失败卡片）与使用方节点，经 portal 渲染进去，
 * 所以节点内容照常读得到外面的 React context。带外壳的 Composer 与不带外壳的使用方都渲染它。 */

import { createPortal } from 'react-dom'
import { ComposerAttachmentPill } from './composer-attachment-pill'
import type { ComposerAttachments } from './use-composer-attachments'
import type { ComposerEditor } from './use-composer-editor'

type ComposerNodeViewsProps = {
  editor: ComposerEditor
  attachments: ComposerAttachments
  /** 失败卡片与悬停预览卡的挂载点：编辑器在弹窗里时给弹窗内的元素（弹窗外点不到），否则给 null 挂到 body。 */
  layerContainer: HTMLElement | null
}

export function ComposerNodeViews({ attachments, editor, layerContainer }: ComposerNodeViewsProps) {
  const { failureCard, hosts, setFailureCard, specOf } = editor.nodeViews
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
          />,
          host.el,
          host.key,
        )
      : createPortal(specOf(host.node.name)?.render(host.node), host.el, host.key),
  )
}
