/**
 * 工具行，结构照 Kimi ToolDisclosure / ToolPanel：20px 图标栏 + 动词 + 对象 + 小箭头，行尾只放状态；
 * 展开是一块 13 行封顶、内部滚动的面板。整行点了展开，文件名是另一个按钮，点了在工作台打开那份文件。
 * 每次调用只按自己的协议状态画：成功不画图标，失败红 ×，被拒绝灰 × 加「已拒绝」，不看前后调用。
 */

import { useState, type ReactNode } from 'react'
import type { ToolCallFrame, TranscriptInteraction } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { baseName } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import {
  frameArtifactId,
  useOpenArtifact,
  useWorkbenchOpenRequest,
  useWorkspaceFileLink,
  workspacePathOf,
} from '@/shared/workbench'
import { CopyButton } from './copy-button'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { EditLines } from './edit-lines'
import {
  toolCard,
  toolMedia,
  toolOutcome,
  toolPanel,
  toolSearchCount,
  type MediaGridItem,
  type SearchMatch,
  type ToolOutcome,
  type ToolPanel,
} from './tool-display'

type ToolLineProps = {
  frame: ToolCallFrame
  /** 本段对话的全部交互，用 approvalId 认出被拒绝的调用。 */
  interactions: ReadonlyMap<string, TranscriptInteraction>
}

export function ToolLine({ frame, interactions }: ToolLineProps) {
  const card = toolCard(frame.display, frame.view)
  const outcome = toolOutcome(frame, interactions)
  const delegated = (frame.agentRefs?.length ?? 0) > 0
  const panel = delegated ? undefined : toolPanel(frame, outcome)
  const media = toolMedia(frame)
  const [open, setOpen] = useState(false)
  // 面板第一次展开才挂载，长文件与 Markdown 不在折叠时白排版。
  const [mounted, setMounted] = useState(false)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const link = useWorkspaceFileLink()
  const { detail: name, file } = card
  // 被拒绝的那一步没动过文件，文件名只写字。
  const openFile = file === undefined || outcome === 'denied' ? undefined : () => link.open(file)

  const subject =
    name === undefined ? null : openFile === undefined ? (
      <span className="min-w-0 truncate">{name}</span>
    ) : (
      <FileName name={name} onOpen={openFile} />
    )
  const tail = <Tail frame={frame} outcome={outcome} />

  return (
    <div className="flex flex-col">
      {delegated ? (
        <DelegatedHead
          icon={card.icon}
          label={card.label}
          tail={tail}
          toolCallId={frame.toolCallId}
        >
          {subject}
        </DelegatedHead>
      ) : (
        <div className="group/row relative flex min-h-5 items-center gap-2 text-body leading-5 text-chat-secondary-text">
          {panel === undefined ? null : (
            // 整行的展开按钮铺在底下，行内容不接指针事件；文件名按钮浮在它上面，两个目标互不嵌套。
            <button
              aria-expanded={open}
              aria-label={`${open ? '收起' : '展开'}「${card.label}${name === undefined ? '' : ` ${name}`}」的详情`}
              className="absolute inset-0 cursor-pointer rounded-xs ui-focus"
              onClick={() => {
                setMounted(true)
                setOpen(!open)
              }}
              type="button"
            />
          )}
          <RowIcon name={card.icon} />
          <span className="pointer-events-none flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">{card.label}</span>
              {subject}
              {panel === undefined ? null : (
                <DisclosureChevron
                  className="text-chat-muted-text ui-motion-s group-hover/row:text-chat-message-text"
                  open={open}
                />
              )}
            </span>
            {tail}
          </span>
        </div>
      )}
      {panel === undefined ? null : (
        <DisclosureBody open={open}>
          <Indented>
            {mounted ? (
              <PanelView
                panel={panel}
                title={
                  name === undefined || openFile === undefined ? undefined : (
                    <FileName className="text-chat-message-text" name={name} onOpen={openFile} />
                  )
                }
              />
            ) : null}
          </Indented>
        </DisclosureBody>
      )}
      {media.length === 0 ? null : (
        <Indented>
          <MediaWall items={media} onOpen={setPreview} />
        </Indented>
      )}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

/** 20px 图标栏，与展开体的缩进、引导线对齐。 */
export function RowIcon({ name }: { name: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <span className="pointer-events-none grid size-5 shrink-0 place-items-center text-chat-muted-text">
      <Icon decorative name={name} size="sm" />
    </span>
  )
}

/** 展开体：左缩进到图标栏之后，图标栏中线上一条虚线引导。 */
export function Indented({ children }: { children: ReactNode }) {
  return (
    <div className="relative pt-1.5 pb-1 pl-7">
      <span
        aria-hidden
        className="absolute inset-y-0 left-[9.5px] border-l border-dashed border-chat-hairline"
      />
      {children}
    </div>
  )
}

/** 行尾：检索命中数；运行中转圈，失败红 ×，被拒绝灰 × 加字。成功不画。 */
function Tail({ frame, outcome }: { frame: ToolCallFrame; outcome: ToolOutcome }) {
  const count = toolSearchCount(frame)
  return (
    <span className="flex shrink-0 items-center gap-2">
      {count === undefined ? null : (
        <span className="text-body-sm text-chat-muted-text tabular-nums">{count}</span>
      )}
      {outcome === 'running' ? (
        <Icon
          className="animate-spin text-chat-status-running"
          label="进行中"
          name="loading"
          size="sm"
        />
      ) : outcome === 'error' ? (
        <Icon className="text-chat-status-error" label="失败" name="failed" size="sm" />
      ) : outcome === 'denied' ? (
        <span className="flex items-center gap-1 text-body-sm text-chat-muted-text">
          已拒绝
          <Icon decorative name="failed" size="sm" />
        </span>
      ) : null}
    </span>
  )
}

/** 文件名按钮：正文字体，悬停变墨色加细下划线，点了在工作台打开。浮在整行展开按钮之上。 */
function FileName({
  className,
  name,
  onOpen,
}: {
  className?: string
  name: string
  onOpen: () => void
}) {
  return (
    <button
      className={cn(
        'pointer-events-auto relative min-w-0 cursor-pointer truncate rounded-xs decoration-1 underline-offset-3 ui-focus ui-motion-s hover:text-chat-message-text hover:underline',
        className,
      )}
      onClick={onOpen}
      title="在工作台打开"
      type="button"
    >
      {name}
    </button>
  )
}

/** 面板头：标题（文件名或「错误信息」）加复制；检索没有头。 */
function PanelView({ panel, title: fileTitle }: { panel: ToolPanel; title: ReactNode }) {
  const copy = panelCopyText(panel)
  const title =
    panel.kind === 'error' ? (
      <span className="text-chat-secondary-text">错误信息</span>
    ) : (
      (fileTitle ?? null)
    )
  return (
    <div className="flex min-w-0 flex-col overflow-clip rounded-sm bg-chat-inline-bg pb-2.5">
      {title === null && copy === undefined ? (
        <div className="h-2" />
      ) : (
        <div className="flex min-w-0 items-center justify-between gap-2 py-1 pr-1.5 pl-3 text-body">
          <span className="flex min-w-0">{title}</span>
          {copy === undefined ? null : <CopyButton text={copy} />}
        </div>
      )}
      <div className="max-h-[13lh] min-w-0 overflow-auto overscroll-contain px-3 text-body leading-[1.571]">
        <PanelBody panel={panel} />
      </div>
    </div>
  )
}

const panelCopyText = (panel: ToolPanel): string | undefined => {
  switch (panel.kind) {
    case 'diff':
      return panel.after
    case 'matches':
      return undefined
    case 'error':
    case 'file':
    case 'text':
      return panel.text
  }
}

function PanelBody({ panel }: { panel: ToolPanel }) {
  switch (panel.kind) {
    case 'file':
      return panel.markdown ? (
        <Markdown text={panel.text} />
      ) : (
        <p className="break-words whitespace-pre-wrap text-chat-message-text">{panel.text}</p>
      )
    case 'diff':
      return (
        // 改动行自带左右内边距与整行底色，抵消面板正文的内边距。
        <div aria-label="改动" className="-mx-3" role="region">
          <EditLines after={panel.after} before={panel.before} />
        </div>
      )
    case 'matches':
      return <MatchesBody matches={panel.matches} truncated={panel.truncated} />
    case 'error':
    case 'text':
      return (
        <p className="text-body-sm leading-[18px] break-words whitespace-pre-wrap text-chat-secondary-text">
          {panel.text}
        </p>
      )
  }
}

/** 检索命中：文件名在前，命中的那一行在后；能对上工作区文件的整条可点。 */
function MatchesBody({
  matches,
  truncated,
}: {
  matches: readonly SearchMatch[]
  truncated: boolean
}) {
  return (
    <ul className="flex flex-col">
      {matches.map((match) => (
        <li key={`${match.file}:${match.line}:${match.text}`}>
          <MatchRow match={match} />
        </li>
      ))}
      {truncated ? <li className="text-chat-muted-text">命中较多，只列出一部分</li> : null}
    </ul>
  )
}

function MatchRow({ match }: { match: SearchMatch }) {
  const link = useWorkspaceFileLink()
  const path = workspacePathOf(match.file)
  const content = (
    <>
      <span className="max-w-[45%] shrink-0 truncate text-chat-muted-text">
        {baseName(path ?? match.file)}
      </span>
      <span className="min-w-0 truncate text-chat-message-text decoration-1 underline-offset-3 group-hover/match:underline">
        {match.text}
      </span>
    </>
  )
  if (path === undefined) return <div className="flex items-baseline gap-2">{content}</div>
  return (
    <button
      className="group/match flex w-full cursor-pointer items-baseline gap-2 rounded-xs text-left ui-focus"
      onClick={() => link.open(path)}
      type="button"
    >
      {content}
    </button>
  )
}

/** 派出了子代理的卡：点开的是工作台里它那条流。产物参数记在 URL 上，刷新与分享都还在；再点一次也能把折叠的工作台重新展开。 */
function DelegatedHead({
  children,
  icon,
  label,
  tail,
  toolCallId,
}: {
  children: ReactNode
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  tail: ReactNode
  toolCallId: string
}) {
  const openArtifact = useOpenArtifact()
  const { requestOpen } = useWorkbenchOpenRequest()
  return (
    <button
      aria-label="查看子代理过程"
      className="flex min-h-5 w-full cursor-pointer items-center gap-2 rounded-xs text-left text-body leading-5 text-chat-secondary-text ui-focus ui-motion-s hover:text-chat-message-text"
      onClick={() => {
        requestOpen()
        void openArtifact(frameArtifactId(toolCallId))
      }}
      type="button"
    >
      <RowIcon name={icon} />
      <span className="shrink-0">{label}</span>
      {children}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <span className="flex items-center gap-0.5 text-body-sm text-chat-muted-text">
          查看
          <Icon decorative name="panel-right" size="sm" />
        </span>
        {tail}
      </span>
    </button>
  )
}

/** 照 Kimi media-tool：图本身就是正文，点开灯箱看原图。 */
function MediaWall({
  items,
  onOpen,
}: {
  items: readonly MediaGridItem[]
  onOpen: (media: LightboxMedia) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        // 没有标题的图（如读图）只画图本身，可访问名称退回「图片」。
        const name = item.caption ?? '图片'
        return (
          <figure className="flex w-[120px] min-w-0 flex-col gap-1.5" key={item.url}>
            <button
              className="cursor-zoom-in overflow-hidden rounded-sm ui-focus"
              onClick={() => onOpen({ kind: 'image', name, url: item.url })}
              type="button"
            >
              <img alt={name} className="block h-[90px] w-[120px] object-cover" src={item.url} />
            </button>
            {item.caption === undefined ? null : (
              <figcaption className="truncate text-body-sm text-chat-secondary-text">
                {item.caption}
              </figcaption>
            )}
          </figure>
        )
      })}
    </div>
  )
}
