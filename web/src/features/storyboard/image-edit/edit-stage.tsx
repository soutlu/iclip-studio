import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { Button } from '@/shared/ui/button'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { StageBackdrop } from '../components/stage-backdrop'
import { StageFailure } from '../components/stage-failure'
import { useElapsed } from '@/shared/ui/media-preview'
import { phaseOfStatus } from '../shots'
import { CompareSlider } from './compare-slider'
import { entryLabel, type StripEntry } from './edit-history'
import type { EditorWords } from './edit-target'

type StageReplace = {
  pending: 'replace' | 'undo' | null
  error: string | null
  undoable: boolean
  onReplace: (url: string) => void
  onUndo: () => void
}

type EditStageProps = {
  entry: StripEntry | undefined
  currentUrl: string | null | undefined
  baseUrl: string
  aspectRatio: string
  canvas: ReactNode
  replace: StageReplace
  words: Pick<
    EditorWords,
    'current' | 'replace' | 'replacing' | 'replaced' | 'replaceTone' | 'gone'
  >
}

function Hero({ aspectRatio, children }: { aspectRatio: string; children: ReactNode }) {
  return (
    <div className="image-edit-hero-wrap">
      <div
        className="image-edit-hero stage-picture"
        style={{ '--image-edit-ratio': aspectValueOf(aspectRatio) } as CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}

function Stage({ backdrop, children }: { backdrop: string | undefined; children: ReactNode }) {
  return (
    <div className="image-edit-stage">
      <StageBackdrop url={backdrop === '' ? undefined : backdrop} />
      {children}
    </div>
  )
}

export function StillStage({
  aspectRatio,
  label,
  url,
}: {
  aspectRatio: string
  label: string
  url: string | null | undefined
}) {
  return (
    <Stage backdrop={url ?? undefined}>
      <Hero aspectRatio={aspectRatio}>
        {url == null ? null : <img alt={label} className="image-edit-hero-image" src={url} />}
      </Hero>
    </Stage>
  )
}

function BaseImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  if (url === '') return null
  if (failed) return <MediaFallback className="image-edit-hero-fallback" compact kind="image" />
  return (
    <img
      alt="本次编辑底图"
      className="image-edit-hero-image"
      onError={() => setFailed(true)}
      src={url}
    />
  )
}

function RunningPill({ since }: { since: string }) {
  const elapsed = useElapsed(since)
  return (
    <span aria-label={`生成中，已用 ${elapsed}`} className="stage-pill" role="status">
      <span aria-hidden="true" className="stage-pill-dot" />
      生成中
      <span className="text-on-surface-muted tabular-nums">{elapsed}</span>
    </span>
  )
}

function useCatchDroppedFocus(target: RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const active = document.activeElement
    if (active === null || active === document.body || active.getAttribute('role') === 'dialog')
      target.current?.focus()
  }, [target, ready])
}

function UndoBar({ done, replace }: { done: string; replace: StageReplace }) {
  const undoRef = useRef<HTMLButtonElement>(null)
  useCatchDroppedFocus(undoRef, replace.pending === null)
  return (
    <div className="image-edit-stage-action">
      <span className="image-edit-undo animate-in ui-motion-m fade-in slide-in-from-bottom-2">
        <span className="image-edit-undo-note" role="status">
          <Icon className="text-on-surface-muted" decorative name="check" size="sm" />
          {done}
        </span>
        <span aria-hidden="true" className="image-edit-undo-divider" />
        <Button
          className="image-edit-undo-button"
          loading={replace.pending === 'undo'}
          onClick={replace.onUndo}
          ref={undoRef}
          size="md"
          variant="ghost"
        >
          撤销
        </Button>
      </span>
      <ReplaceError error={replace.error} />
    </div>
  )
}

function ReplaceBar({
  replace,
  url,
  words,
}: {
  replace: StageReplace
  url: string
  words: Pick<EditorWords, 'replace' | 'replacing' | 'replaceTone'>
}) {
  const replaceRef = useRef<HTMLButtonElement>(null)
  useCatchDroppedFocus(replaceRef, replace.pending === null)
  return (
    <div className="image-edit-stage-action">
      <Button
        className="image-edit-replace"
        disabled={replace.pending !== null}
        leadingIcon={words.replaceTone === 'primary' ? 'replace' : 'check'}
        loading={replace.pending === 'replace'}
        onClick={() => replace.onReplace(url)}
        ref={replaceRef}
        variant={words.replaceTone === 'primary' ? 'primary' : 'inverted'}
      >
        {replace.pending === 'replace' ? words.replacing : words.replace}
      </Button>
      <ReplaceError error={replace.error} />
    </div>
  )
}

function ReplaceError({ error }: { error: string | null }) {
  if (error === null) return null
  return (
    <p className="image-edit-replace-error" role="alert">
      <Icon decorative name="alert" size="sm" />
      {error}
    </p>
  )
}

export function EditStage({
  entry,
  currentUrl,
  baseUrl,
  aspectRatio,
  canvas,
  replace,
  words,
}: EditStageProps) {
  if (currentUrl === undefined)
    return (
      <Stage backdrop={undefined}>
        <p className="image-edit-stage-message" role="alert">
          {words.gone}
        </p>
      </Stage>
    )

  if (entry === undefined || entry.kind === 'current')
    return (
      <Stage backdrop={currentUrl ?? undefined}>
        {currentUrl === null ? (
          <p className="image-edit-stage-message">暂无在用的图片，请从版本中选择一张</p>
        ) : (
          canvas
        )}
        {replace.undoable ? <UndoBar done={words.replaced} replace={replace} /> : null}
      </Stage>
    )

  if (entry.kind === 'pending') {
    const queued = phaseOfStatus(entry.job.status) === 'queued'
    return (
      <Stage backdrop={baseUrl}>
        <Hero aspectRatio={aspectRatio}>
          <BaseImage key={baseUrl} url={baseUrl} />
          <span aria-hidden="true" className="stage-dim" />
          <div className="stage-status">
            {queued ? (
              <span className="stage-pill" role="status">
                <Icon className="text-on-surface-muted" decorative name="duration" size="sm" />
                排队中
              </span>
            ) : (
              <RunningPill since={entry.job.createdAt} />
            )}
          </div>
        </Hero>
      </Stage>
    )
  }

  if (entry.kind === 'failed')
    return (
      <Stage backdrop={baseUrl}>
        <Hero aspectRatio={aspectRatio}>
          <BaseImage key={baseUrl} url={baseUrl} />
          <StageFailure key={entry.key} message={entry.job.errorMessage?.trim()} title="生成失败" />
        </Hero>
      </Stage>
    )

  return (
    <Stage backdrop={entry.url}>
      <Hero aspectRatio={aspectRatio}>
        {currentUrl === null ? (
          <img
            alt={entryLabel(entry, words.current)}
            className="image-edit-hero-image"
            src={entry.url}
          />
        ) : (
          <CompareSlider
            after={{ label: entryLabel(entry, words.current), url: entry.url }}
            before={{ label: words.current, url: currentUrl }}
            key={`${currentUrl}:${entry.url}`}
          />
        )}
      </Hero>
      <ReplaceBar replace={replace} url={entry.url} words={words} />
    </Stage>
  )
}
