import { useId, type ReactNode, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { useElapsed } from '@/shared/ui/media-preview'
import { VideoPlayer } from '@/shared/ui/video-player'
import type { TestVideo } from '../references.api'

const TEST_MODEL_LABEL = 'wan3 480p'

type CompareOverlayProps = {
  label: string
  meta?: string | undefined
  action?: ReactNode
  note?: ReactNode
}

export function CompareOverlay({ label, meta, action, note }: CompareOverlayProps) {
  return (
    <div className="layer-local-1 pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-1.5 max-md:inset-x-2 max-md:top-2">
      <div className="flex w-full items-start justify-between gap-2">
        <p className="reference-compare-glass h-7 rounded-full px-2.5 text-label leading-6.5 font-semibold whitespace-nowrap">
          {label}
          {meta === undefined ? null : (
            <span className="font-medium text-on-scrim/72 max-md:hidden"> · {meta}</span>
          )}
        </p>
        {action === undefined ? null : <div className="pointer-events-auto flex">{action}</div>}
      </div>
      {note}
    </div>
  )
}

type TestVideoCellProps = {
  testVideo: TestVideo | null | undefined
  canEdit: boolean
  ready: boolean
  measured: boolean
  starting: boolean
  poster: string | undefined
  onStart: () => void
  onExpand: (url: string, at: number) => void
  playerRef: Ref<HTMLVideoElement>
}

export function TestVideoCell({
  testVideo,
  canEdit,
  ready,
  measured,
  starting,
  poster,
  onStart,
  onExpand,
  playerRef,
}: TestVideoCellProps) {
  const canRetry = ready && measured && !starting

  if (testVideo === undefined) return <SlotFrame poster={poster}>{null}</SlotFrame>

  if (testVideo?.status === 'completed' && testVideo.url !== null) {
    const { url } = testVideo
    return (
      <div className="reference-compare-cell">
        <VideoPlayer
          className="absolute inset-0 bg-surface-container-low"
          label="试生成"
          loop
          onExpand={(at) => onExpand(url, at)}
          ref={playerRef}
          src={url}
        />
        <CompareOverlay
          action={
            canEdit ? (
              <GlassRetry compact disabled={!canRetry} onClick={onStart} starting={starting} />
            ) : undefined
          }
          label="试生成"
          meta={TEST_MODEL_LABEL}
          note={
            testVideo.stale ? (
              <p className="reference-compare-glass flex max-w-full items-start gap-1.5 rounded-sm px-2.5 py-1.25 text-caption">
                <Icon className="mt-0.5 shrink-0" decorative name="info" size="sm" />
                <span>拆解已更新，该结果按更新前的拆解生成</span>
              </p>
            ) : undefined
          }
        />
      </div>
    )
  }

  if (testVideo?.status === 'running')
    return (
      <SlotFrame poster={poster} role="status">
        <SlotIcon>
          <Icon className="animate-spin" decorative name="spinner" size="md" />
        </SlotIcon>
        <RunningTitle since={testVideo.createdAt} />
        <SlotNote>关闭详情不影响生成</SlotNote>
      </SlotFrame>
    )

  if (testVideo !== null) {
    const reason =
      testVideo.status === 'completed' ? '未返回视频地址' : (testVideo.errorMessage ?? '')
    return (
      <SlotFrame poster={poster} role="alert">
        <SlotIcon>
          <Icon className="text-error" decorative name="alert" size="md" />
        </SlotIcon>
        <SlotTitle>试生成失败</SlotTitle>
        {reason === '' ? null : <SlotNote>{reason}</SlotNote>}
        {canEdit ? (
          <div className="mt-3">
            <GlassRetry
              compact={false}
              disabled={!canRetry}
              onClick={onStart}
              starting={starting}
            />
          </div>
        ) : null}
      </SlotFrame>
    )
  }

  if (!canEdit)
    return (
      <SlotFrame poster={poster}>
        <SlotIcon>
          <Icon decorative name="video" size="md" />
        </SlotIcon>
        <SlotTitle>暂无试生成</SlotTitle>
      </SlotFrame>
    )

  return (
    <StartPrompt
      measured={measured}
      onStart={onStart}
      poster={poster}
      ready={ready}
      starting={starting}
    />
  )
}

function StartPrompt({
  ready,
  measured,
  starting,
  poster,
  onStart,
}: Pick<TestVideoCellProps, 'ready' | 'measured' | 'starting' | 'poster' | 'onStart'>) {
  const noteId = useId()
  return (
    <SlotFrame poster={poster}>
      <SlotIcon>
        <Icon decorative name="video" size="md" />
      </SlotIcon>
      <SlotTitle>用拆解试生成</SlotTitle>
      {ready ? (
        <>
          <SlotNote id={noteId}>仅用拆解文字生成视频，与原片对照可检查拆解是否完整</SlotNote>
          <Button
            aria-describedby={noteId}
            className="mt-3 rounded-full disabled:bg-on-scrim/14 disabled:text-on-scrim/60 disabled:shadow-none"
            disabled={!measured}
            leadingIcon="video"
            loading={starting}
            onClick={onStart}
            size="md"
            variant="primary"
          >
            试生成
          </Button>
          <p className="mt-0.5 text-caption text-on-scrim/52">wan3 · 480p</p>
        </>
      ) : (
        <>
          <SlotNote id={noteId}>拆解尚未完成，无法试生成</SlotNote>
          <button
            aria-describedby={noteId}
            aria-disabled="true"
            className="mt-3 inline-flex h-(--control-height-md) cursor-not-allowed items-center gap-2 rounded-full bg-on-scrim/14 px-4 text-body-sm font-medium text-on-scrim/60 ui-focus"
            type="button"
          >
            <Icon decorative name="video" size="md" />
            试生成
          </button>
        </>
      )}
    </SlotFrame>
  )
}

function SlotFrame({
  poster,
  role,
  children,
}: {
  poster: string | undefined
  role?: 'status' | 'alert'
  children: ReactNode
}) {
  return (
    <div className="reference-compare-cell overflow-hidden rounded-md bg-scrim">
      {poster === undefined ? null : (
        <img alt="" aria-hidden className="reference-test-backdrop" src={poster} />
      )}
      <CompareOverlay label="试生成" />
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 pt-14 pb-6 text-center text-on-scrim max-md:px-3 max-md:pt-11 max-md:pb-3"
        role={role}
      >
        {children}
      </div>
    </div>
  )
}

function SlotIcon({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="reference-compare-glass mb-1.5 inline-grid size-11 place-items-center rounded-full max-md:size-9"
    >
      {children}
    </span>
  )
}

function SlotTitle({ children }: { children: ReactNode }) {
  return <p className="text-body font-semibold">{children}</p>
}

function SlotNote({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      className="max-w-[17em] text-caption text-balance break-words text-on-scrim/72 max-md:text-label"
      id={id}
    >
      {children}
    </p>
  )
}

function RunningTitle({ since }: { since: string }) {
  const elapsed = useElapsed(since)
  return (
    <SlotTitle>
      试生成中 · <span className="tabular-nums">{elapsed}</span>
    </SlotTitle>
  )
}

function GlassRetry({
  compact,
  disabled,
  starting,
  onClick,
}: {
  compact: boolean
  disabled: boolean
  starting: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'reference-compare-glass inline-flex cursor-pointer items-center gap-1.5 rounded-full ui-focus',
        compact
          ? 'h-8 pr-3 pl-2.5 text-label font-semibold max-md:w-8 max-md:justify-center max-md:p-0'
          : 'h-(--control-height-md) pr-3.5 pl-3 text-body-sm font-medium',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {starting ? (
        <Icon className="animate-spin" decorative name="loading" size="sm" />
      ) : (
        <Icon decorative name="refresh" size="sm" />
      )}
      <span className={compact ? 'max-md:sr-only' : undefined}>重新试生成</span>
    </button>
  )
}
