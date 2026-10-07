/** 阅读一份工作区文件：头上是返回、目录与文件名、JSON 的全部收起 / 展开、复制原文；正文按渲染器族分派。 */

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
  // 解析结果要稳定：收起状态与排好的行都跟着它记忆。
  const json = useMemo(
    () => (kind === 'json' && content !== undefined && !empty ? parseJson(content) : undefined),
    [content, empty, kind],
  )
  const fold = useJsonFold(json?.ok === true ? json.value : undefined)
  // 这份文件若本身登记成了别的产物（比如分镜），给一个去那边看的入口；匹配只看路径，版本号只是凑齐类型。
  const own = registry.matchFiles([{ path, version: file.data?.file.version ?? 0 }])[0]
  const dir = dirName(path)
  const name = splitFileName(baseName(path))

  const copy = async () => {
    if (content === undefined) return
    try {
      await copyText(content)
      toast('已复制')
    } catch {
      toast.error('复制失败')
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
          {/* 截中间：目录与文件名开头一起从末尾截，主名末 4 字加扩展名固定不截；全名留在文本里供读屏，悬停看 title。 */}
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
          <PanelNotice hint="它已经被删掉了，回列表看看还有什么。" text="这个文件已经不在了" />
        ) : (
          <PanelNotice text={errorMessageOf(file.error, '读取工作区文件失败')} />
        )
      ) : empty ? (
        <PanelNotice text="这份文件还是空的" />
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
