import { use, useState, type ReactNode } from 'react'
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
import { WorkbenchLinksContext } from './workbench-links'

type ToolLineProps = {
  frame: ToolCallFrame
  interactions: ReadonlyMap<string, TranscriptInteraction>
  backgrounded: boolean
}

export function ToolLine({ backgrounded, frame, interactions }: ToolLineProps) {
  const card = toolCard(frame.display, frame.view)
  const outcome = toolOutcome(frame, interactions)
  const delegated = (frame.agentRefs?.length ?? 0) > 0
  const panel = delegated ? undefined : toolPanel(frame, outcome)
  const media = toolMedia(frame)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const link = useWorkspaceFileLink()
  const linked = use(WorkbenchLinksContext)
  const { detail: name, file } = card
  const openFile =
    file === undefined || outcome === 'denied' || !linked ? undefined : () => link.open(file)

  const subject =
    name === undefined ? null : openFile === undefined ? (
      <span className="min-w-0 truncate">{name}</span>
    ) : (
      <FileName name={name} onOpen={openFile} />
    )
  const tail = <Tail backgrounded={backgrounded} frame={frame} outcome={outcome} />

  return (
    <div className="flex flex-col">
      {delegated && linked ? (
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
            {!mounted ? null : panel.kind === 'error' ? (
              <DetailText>{panel.text}</DetailText>
            ) : (
              <PanelView
                panel={panel}
                title={
                  name === undefined || openFile === undefined ? undefined : (
                    <FileName className="text-chat-message-text" name={name} onOpen={openFile} />
                  )
                }
              />
            )}
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

export function RowIcon({ name }: { name: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <span className="pointer-events-none grid size-5 shrink-0 place-items-center text-chat-muted-text">
      <Icon decorative name={name} size="sm" />
    </span>
  )
}

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

export function DetailText({ children }: { children: ReactNode }) {
  return (
    <p className="text-body-sm leading-5 whitespace-pre-wrap text-chat-secondary-text">
      {children}
    </p>
  )
}

function Tail({
  backgrounded,
  frame,
  outcome,
}: {
  backgrounded: boolean
  frame: ToolCallFrame
  outcome: ToolOutcome
}) {
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
      ) : outcome === 'done' && backgrounded ? (
        <span className="text-body-sm text-chat-muted-text">已转入后台</span>
      ) : null}
    </span>
  )
}

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

type BoxedPanel = Exclude<ToolPanel, { kind: 'error' }>

function PanelView({ panel, title = null }: { panel: BoxedPanel; title: ReactNode }) {
  const copy = panelCopyText(panel)
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

const panelCopyText = (panel: BoxedPanel): string | undefined => {
  switch (panel.kind) {
    case 'diff':
      return panel.after
    case 'matches':
      return undefined
    case 'file':
    case 'text':
      return panel.text
  }
}

function PanelBody({ panel }: { panel: BoxedPanel }) {
  switch (panel.kind) {
    case 'file':
      return panel.markdown ? (
        <Markdown text={panel.text} />
      ) : (
        <p className="break-words whitespace-pre-wrap text-chat-message-text">{panel.text}</p>
      )
    case 'diff':
      return (
        <div aria-label="改动" className="-mx-3" role="region">
          <EditLines after={panel.after} before={panel.before} />
        </div>
      )
    case 'matches':
      return <MatchesBody matches={panel.matches} truncated={panel.truncated} />
    case 'text':
      return (
        <p className="text-body-sm leading-[18px] break-words whitespace-pre-wrap text-chat-secondary-text">
          {panel.text}
        </p>
      )
  }
}

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
      {truncated ? <li className="text-chat-muted-text">命中较多，仅列出部分结果</li> : null}
    </ul>
  )
}

function MatchRow({ match }: { match: SearchMatch }) {
  const link = useWorkspaceFileLink()
  const linked = use(WorkbenchLinksContext)
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
  if (path === undefined || !linked)
    return <div className="flex items-baseline gap-2">{content}</div>
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
