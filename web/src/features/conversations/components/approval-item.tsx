import { Fragment, useId, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { baseName, fileKindOf } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { workspacePathOf } from '@/shared/workbench'
import type { ApprovalItem } from './approval-batch'
import {
  approvalParams,
  isAsciiIdentifier,
  paramImages,
  paramRows,
  type ApprovalParams,
} from './approval-params'
import { CopyButton } from './copy-button'
import { EditLines } from './edit-lines'
import { fileChangeOf, toolCard, type FileChange } from './tool-display'
import { useClampable } from './use-clampable'

type ApprovalItemBodyProps = {
  item: ApprovalItem
  actions: ReactNode
  account: ReactNode
  single: boolean
}

export function ApprovalItemBody({ account, actions, item, single }: ApprovalItemBodyProps) {
  const change = fileChangeOf(item.frame?.display)
  return change === undefined ? (
    <ToolItem account={account} actions={actions} item={item} single={single} />
  ) : (
    <FileItem actions={actions} change={change} item={item} />
  )
}

function ToolItem({ account, actions, item, single }: ApprovalItemBodyProps) {
  const { frame } = item
  const card = toolCard(frame?.display, frame?.view)
  const params = approvalParams(frame?.input)
  const images = params === undefined ? [] : paramImages(params)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const listed = expanded && params !== undefined
  const thumbs = !listed && images.length > 0
  const tight = !listed && !thumbs
  const compact = single && tight
  const icon: IconName = frame?.name.startsWith('mcp_') === true ? 'mcp-server' : card.icon

  return (
    <div className={cn('flex flex-col', compact && '@lg:flex-row @lg:items-center')}>
      <ItemHeader
        className={tight ? cn('pt-3 pb-1.5', compact && '@lg:flex-1 @lg:py-3 @lg:pr-0') : 'py-3'}
        controls={
          params === undefined ? null : (
            <>
              {listed ? (
                <CopyButton label="复制参数" text={JSON.stringify(params, null, 2)} />
              ) : null}
              <DisclosureToggle
                controls={listId}
                expanded={listed}
                onToggle={() => setExpanded(!listed)}
              >
                参数
              </DisclosureToggle>
            </>
          )
        }
        icon={icon}
        subject={listed || card.detail === undefined ? null : <KeyDetail text={card.detail} />}
        title={card.label}
      />
      {listed ? (
        <ContentBand>
          <ParamList id={listId} params={params} />
        </ContentBand>
      ) : null}
      {thumbs ? <ParamThumbs urls={images} /> : null}
      <ItemFooter
        actions={actions}
        className={
          tight
            ? cn('pt-1.5 pb-3', compact && '@lg:shrink-0 @lg:py-3 @lg:pl-3')
            : cn('py-2.5', thumbs && 'border-t-[0.5px] border-chat-hairline')
        }
        lead={compact ? <div className="@lg:hidden">{account}</div> : account}
      />
    </div>
  )
}

const PREVIEW_LINES = 12

function FileItem({
  actions,
  change,
  item,
}: {
  actions: ReactNode
  change: FileChange
  item: ApprovalItem
}) {
  const card = toolCard(item.frame?.display, item.frame?.view)
  const [expanded, setExpanded] = useState(false)
  const text = 'content' in change ? change.content : `${change.before}\n${change.after}`
  const { clampable, ref } = useClampable(PREVIEW_LINES, text)
  const bodyId = useId()

  return (
    <div className="flex flex-col">
      <ItemHeader
        className="py-3"
        icon={card.icon}
        subject={<FilePath path={change.path} />}
        title={card.label}
      />
      <ContentBand>
        <div className="py-3">
          <div
            aria-label="改动预览"
            className={cn(
              'text-body leading-relaxed text-chat-message-text',
              clampable && (expanded ? 'chat-preview-expanded' : 'chat-preview-clamp'),
            )}
            id={bodyId}
            ref={ref}
            role="region"
          >
            {'content' in change ? (
              fileKindOf(change.path) === 'markdown' ? (
                <Markdown className="px-4" text={change.content} />
              ) : (
                <p className="px-4 break-words whitespace-pre-wrap">{change.content}</p>
              )
            ) : (
              <div className="px-1">
                <EditLines after={change.after} before={change.before} />
              </div>
            )}
          </div>
        </div>
      </ContentBand>
      <ItemFooter
        actions={actions}
        className="py-2.5"
        lead={
          clampable ? (
            <DisclosureToggle
              className="-ml-1.5"
              controls={bodyId}
              expanded={expanded}
              onToggle={() => setExpanded(!expanded)}
            >
              {expanded ? '收起' : '展开全部'}
            </DisclosureToggle>
          ) : null
        }
      />
    </div>
  )
}

function ItemHeader({
  className,
  controls = null,
  icon,
  subject,
  title,
}: {
  className: string
  controls?: ReactNode
  icon: IconName
  subject: ReactNode
  title: string
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5 px-4', className)}>
      <span className="grid size-5 shrink-0 place-items-center text-chat-secondary-text">
        <Icon decorative name={icon} size="md" />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h2 className="max-w-full shrink-0 truncate text-body font-semibold text-chat-message-text">
          {title}
        </h2>
        {subject}
      </div>
      {controls === null ? null : (
        <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">{controls}</div>
      )}
    </div>
  )
}

function ItemFooter({
  actions,
  className,
  lead,
}: {
  actions: ReactNode
  className: string
  lead: ReactNode
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-4', className)}>
      <div className="min-w-0 flex-1">{lead}</div>
      <div className="flex min-h-(--control-height-md) shrink-0 items-center">{actions}</div>
    </div>
  )
}

function ContentBand({ children }: { children: ReactNode }) {
  return <div className="border-y-[0.5px] border-chat-hairline bg-surface">{children}</div>
}

function DisclosureToggle({
  children,
  className,
  controls,
  expanded,
  onToggle,
}: {
  children: string
  className?: string
  controls: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      aria-controls={controls}
      aria-expanded={expanded}
      className={cn(
        'inline-flex h-(--control-height-xs) ui-state cursor-pointer items-center gap-1 rounded-xs px-1.5 text-body-sm text-chat-muted-text ui-focus hover:text-chat-message-text aria-expanded:text-chat-message-text',
        className,
      )}
      onClick={onToggle}
      type="button"
    >
      {children}
      <Icon decorative name={expanded ? 'collapse' : 'expand'} size="xs" />
    </button>
  )
}

function KeyDetail({ text }: { text: string }) {
  return (
    <span
      className={cn(
        'min-w-0 flex-1 truncate text-body-sm text-chat-muted-text',
        isAsciiIdentifier(text) ? 'font-mono' : 'tabular-nums',
      )}
    >
      {text}
    </span>
  )
}

function FilePath({ path }: { path: string }) {
  const name = baseName(path)
  const workspace = workspacePathOf(path)
  const dir = workspace === undefined ? '' : workspace.slice(0, workspace.length - name.length)
  return (
    <span className="min-w-0 flex-1 truncate text-body-sm text-chat-secondary-text">
      {dir === '' ? null : <span className="text-chat-muted-text">{dir}</span>}
      <span>{name}</span>
    </span>
  )
}

function ParamList({ id, params }: { id: string; params: ApprovalParams }) {
  return (
    <dl
      className="grid max-h-[13lh] grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-4 gap-y-1.5 overflow-auto overscroll-contain px-4 py-3 text-ui"
      id={id}
    >
      {paramRows(params).map((row) => (
        <Fragment key={row.key}>
          <dt className="font-mono break-all text-chat-muted-text">{row.key}</dt>
          <dd
            className={cn(
              'wrap-anywhere whitespace-pre-wrap text-chat-message-text',
              row.numeric && 'tabular-nums',
            )}
          >
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

function ParamThumbs({ urls }: { urls: readonly string[] }) {
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  return (
    <>
      <ul className="grid max-w-100 grid-cols-2 gap-3 px-4 pb-3.5">
        {urls.map((url, index) => {
          const name = `参数图片 ${index + 1}`
          return (
            <li key={url}>
              <button
                className="block w-full cursor-zoom-in overflow-hidden rounded-sm ui-focus"
                onClick={() => setPreview({ kind: 'image', name, url })}
                type="button"
              >
                <img alt={name} className="aspect-video w-full object-cover" src={url} />
              </button>
            </li>
          )
        })}
      </ul>
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}
