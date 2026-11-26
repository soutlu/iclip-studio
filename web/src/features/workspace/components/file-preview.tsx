import { useMemo, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { ConversationFileOut } from '@/shared/api/generated'
import { Icon } from '@/shared/icons'
import { copyText } from '@/shared/lib/clipboard'
import { baseName, fileKindOf } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Markdown } from '@/shared/ui/markdown'
import { SourceViewer, type SourceViewerHandle } from '@/shared/ui/source-editor'
import { toast } from '@/shared/ui/toast'
import { RAISED_CARD_HOVER_CLASS, useOpenArtifact, useWorkspaceFile } from '@/shared/workbench'
import { dirName, fileLookOf, formatBytes, formatWhen, splitFileName } from '../file-kind'
import { documentToneOf, type FileOwner } from '../file-owner'
import { formatJson } from '../json-format'
import { PanelNotice } from './panel-notice'
import { ToneIcon } from './tone-icon'

type FilePreviewProps = {
  conversationId: string
  path: string
  /** 文件列表中的元信息记录（用于头部展示文件大小与更新时间）；文件已从列表中移除时为 `undefined`。 */
  entry: ConversationFileOut | undefined
  /** 该文件归属的工作台页签（见 `fileOwnerOf`）；存在时展示直达按钮。 */
  owner: FileOwner | undefined
  /** 窄屏下返回文件列表的回调；宽屏左侧常驻目录树，不传入。 */
  onBack?: (() => void) | undefined
}

// 拼接直达按钮文案（如「打开 final-cut」「打开分镜」）：ASCII 标题前保留一个空格
const openLabelOf = (title: string): string =>
  /^[\x21-\x7e]/.test(title) ? `打开 ${title}` : `打开${title}`

/** 工作区单文件预览视图：头部展示路径、直达页签入口与操作按钮，正文按文件类型在卡片内渲染。 */
export function FilePreview({ conversationId, entry, onBack, owner, path }: FilePreviewProps) {
  const file = useWorkspaceFile(conversationId, path)
  const openArtifact = useOpenArtifact()
  const viewerRef = useRef<SourceViewerHandle>(null)
  const [folded, setFolded] = useState(false)

  const content = file.data?.file.content
  const empty = content !== undefined && content.trim() === ''
  const kind = fileKindOf(path, content)
  const formatted = useMemo(
    () => (kind === 'json' && content !== undefined ? formatJson(content) : undefined),
    [content, kind],
  )
  const look = fileLookOf(path)
  // 纯文本（如口播文案）按正文排版且不显示行号；代码与 JSON 使用只读原文查看器
  const prose = kind === 'text' && !look.foldable
  const foldable = content !== undefined && !empty && kind !== 'markdown' && !prose
  const dir = dirName(path)
  const name = splitFileName(baseName(path))

  const copy = async () => {
    if (content === undefined) return
    try {
      await copyText(content)
      toast('已复制')
    } catch {
      toast.error('复制失败，请重试')
    }
  }

  return (
    // 面板宽度低于 320px 时维持最小宽度，溢出部分由外层面板裁切
    <div className="flex min-h-0 min-w-80 flex-1 flex-col">
      <div
        className={cn(
          'flex h-12 shrink-0 items-center gap-2.5 border-b border-panel-line pr-3',
          onBack === undefined ? 'pl-4' : 'pl-2',
        )}
      >
        {onBack === undefined ? null : (
          <IconButton label="返回文件列表" name="back" onClick={onBack} size="sm" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <ToneIcon name={look.icon} tone={documentToneOf(owner) ?? look.tone} />
          <h3 className="flex min-w-[1ch] overflow-hidden text-ui whitespace-nowrap" title={path}>
            <span className="min-w-[1ch] truncate">
              {dir === '' ? null : <span className="text-on-surface-faint">{dir}/</span>}
              <span className="font-semibold text-on-surface">{name.head}</span>
            </span>
            {name.tail === '' ? null : (
              <span className="shrink-0 font-semibold text-on-surface">{name.tail}</span>
            )}
          </h3>
          {entry === undefined ? null : (
            // 仅占剩余空间：宽度不足时优先压缩元信息，再截断文件名
            <span className="ml-1 min-w-0 flex-1 truncate font-mono text-caption text-on-surface-faint">
              {formatBytes(entry.sizeBytes)} · {formatWhen(entry.updatedAt)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {owner === undefined ? null : (
            <button
              className={cn(
                'inline-flex h-7 ui-state cursor-pointer items-center gap-1 rounded-sm bg-card pr-2.5 pl-2 text-label font-semibold text-on-surface shadow-[var(--shadow-pill),var(--shadow-specular)] ui-focus active:scale-[0.97]',
                RAISED_CARD_HOVER_CLASS,
              )}
              onClick={() => void openArtifact(owner.artifactId)}
              type="button"
            >
              <ToneIcon name={owner.icon} tone={owner.tone ?? look.tone} />
              {openLabelOf(owner.title)}
              <Icon className="text-on-surface-faint" decorative name="disclosure" size="xs" />
            </button>
          )}
          {foldable ? (
            <IconButton
              label={folded ? '全部展开' : '全部收起'}
              name={folded ? 'expand' : 'collapse'}
              onClick={() =>
                folded ? viewerRef.current?.unfoldAll() : viewerRef.current?.foldAll()
              }
              size="sm"
              tooltip={folded ? '全部展开' : '全部收起'}
            />
          ) : null}
          <IconButton
            disabled={content === undefined}
            label="复制原文"
            name="copy"
            onClick={() => void copy()}
            size="sm"
            tooltip="复制原文"
          />
        </div>
      </div>

      {file.isPending ? (
        <PanelNotice text="正在读取文件…" />
      ) : file.isError ? (
        file.error instanceof ApiError && file.error.status === 404 ? (
          <PanelNotice
            hint={
              onBack === undefined
                ? '该文件已被删除；请在左侧选择其他文件'
                : '该文件已被删除；请返回文件列表查看其他文件'
            }
            text="该文件已不存在"
          />
        ) : (
          <PanelNotice text={errorMessageOf(file.error, '读取工作区文件失败，请重试')} />
        )
      ) : empty ? (
        <PanelNotice text="该文件暂无内容" />
      ) : (
        <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto p-3">
          <div className="overflow-hidden rounded-md bg-card shadow-[var(--shadow-panel-card),var(--shadow-specular)]">
            {kind === 'markdown' ? (
              <article className="px-5 pt-4 pb-5">
                <Markdown text={file.data.file.content} />
              </article>
            ) : prose ? (
              <p className="px-5 pt-4 pb-5 text-body leading-relaxed wrap-anywhere whitespace-pre-wrap text-on-surface select-text">
                {file.data.file.content}
              </p>
            ) : (
              <>
                {kind === 'json' && formatted === undefined ? (
                  <p className="flex items-center gap-1.5 border-b border-panel-line px-4 py-2.5 text-body-sm text-chat-secondary-text">
                    <Icon
                      className="shrink-0 text-chat-status-error"
                      decorative
                      name="failed"
                      size="sm"
                    />
                    JSON 格式有误，已按原文显示
                  </p>
                ) : null}
                <SourceViewer
                  ariaLabel="文件内容"
                  fileName={baseName(path)}
                  kind={kind}
                  onFoldedChange={setFolded}
                  ref={viewerRef}
                  value={formatted ?? file.data.file.content}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
