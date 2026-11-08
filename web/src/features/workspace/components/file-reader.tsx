import { useMemo } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { copyText } from '@/shared/lib/clipboard'
import { baseName, fileKindOf } from '@/shared/lib/file-kind'
import { Button, IconButton } from '@/shared/ui/button'
import { Markdown } from '@/shared/ui/markdown'
import { toast } from '@/shared/ui/toast'
import { useOpenArtifact, useWorkbenchRegistry, useWorkspaceFile } from '@/shared/workbench'
import { dirName, fileIconOf, splitFileName } from '../file-kind'
import { parseJson } from '../json-format'
import { useJsonFold } from '../use-json-fold'
import { JsonParseFailure, JsonView } from './json-view'
import { PanelNotice } from './panel-notice'
import { PlainText } from './plain-text'

type FileReaderProps = {
  conversationId: string
  path: string
  onBack: () => void
}

export function FileReader({ conversationId, onBack, path }: FileReaderProps) {
  const file = useWorkspaceFile(conversationId, path)
  const registry = useWorkbenchRegistry()
  const openArtifact = useOpenArtifact()
  const content = file.data?.file.content
  const empty = content !== undefined && content.trim() === ''
  const kind = fileKindOf(path, content)
  const json = useMemo(
    () => (kind === 'json' && content !== undefined && !empty ? parseJson(content) : undefined),
    [content, empty, kind],
  )
  const fold = useJsonFold(json?.ok === true ? json.value : undefined)
  const own = registry.matchFiles([{ path, version: file.data?.file.version ?? 0 }])[0]
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b-[0.5px] border-chat-hairline px-2">
        <IconButton label="返回文件列表" name="back" onClick={onBack} size="md" />
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-body font-medium text-on-surface">
          <Icon
            className="shrink-0 text-on-surface-variant"
            decorative
            name={fileIconOf(path)}
            size="sm"
          />
          <span className="flex min-w-0 whitespace-nowrap" title={path}>
            <span className="min-w-[1ch] truncate">
              {dir === '' ? null : (
                <span className="font-normal text-on-surface-faint">{dir}/</span>
              )}
              {name.head}
            </span>
            {name.tail === '' ? null : <span className="shrink-0">{name.tail}</span>}
          </span>
        </h3>
        {own === undefined ? null : (
          <Button
            className="shrink-0"
            onClick={() => void openArtifact(own.id)}
            size="md"
            variant="ghost"
          >
            在{own.title}里打开
          </Button>
        )}
        {json?.ok === true && fold.canFoldAll ? (
          <Button
            className="shrink-0"
            onClick={fold.foldedAll ? fold.unfoldAll : fold.foldAll}
            size="md"
            variant="ghost"
          >
            {fold.foldedAll ? '全部展开' : '全部收起'}
          </Button>
        ) : null}
        <IconButton
          className="shrink-0"
          disabled={content === undefined}
          label="复制原文"
          name="copy"
          onClick={() => void copy()}
          size="md"
        />
      </div>

      {file.isPending ? (
        <PanelNotice text="正在读取文件…" />
      ) : file.isError ? (
        file.error instanceof ApiError && file.error.status === 404 ? (
          <PanelNotice hint="该文件已被删除，请返回文件列表查看其他文件" text="该文件已不存在" />
        ) : (
          <PanelNotice text={errorMessageOf(file.error, '读取工作区文件失败，请重试')} />
        )
      ) : empty ? (
        <PanelNotice text="该文件暂无内容" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {kind === 'markdown' ? (
            <article className="px-6 py-5">
              <Markdown text={file.data.file.content} />
            </article>
          ) : json === undefined ? (
            <div className="px-6 py-5">
              <PlainText text={file.data.file.content} />
            </div>
          ) : json.ok ? (
            <div className="py-3 pr-5 pl-1">
              <JsonView fold={fold} />
            </div>
          ) : (
            <div className="px-6 py-5">
              <JsonParseFailure text={file.data.file.content} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
