/** 编辑器的舞台：按版本条上选中的那条分流显示，自己不改选中。 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { useTakeElapsed } from '../components/use-take-elapsed'
import { phaseOfStatus } from '../shots'
import { CompareSlider } from './compare-slider'
import { entryLabel, type StripEntry } from './edit-history'
import type { EditorWords } from './edit-target'

/** 替换当前帧与撤销的状态，由 useFrameReplace 提供。 */
type StageReplace = {
  pending: 'replace' | 'undo' | null
  error: string | null
  /** 刚替换过、撤销入口还在。 */
  undoable: boolean
  onReplace: (url: string) => void
  onUndo: () => void
}

type EditStageProps = {
  /** 选中的条目；条目还没读回来时为空，按当前帧显示。 */
  entry: StripEntry | undefined
  /** 分镜里这一帧此刻的图；帧已经不在分镜里时为 undefined，没有在用的图（制作页没选用的生成图）时为 null。 */
  currentUrl: string | null | undefined
  /** 选中条目的底图：在途与失败的任务显示它当初的底图；没有底图时是空串。 */
  baseUrl: string
  aspectRatio: string
  /** 当前帧上的标注画布。 */
  canvas: ReactNode
  replace: StageReplace
  /** 随所在页面变的称呼与主操作的样子：在用的那一版、主操作、图已经不在了。 */
  words: Pick<
    EditorWords,
    'current' | 'replace' | 'replacing' | 'replaced' | 'replaceTone' | 'gone'
  >
}

/** 不是画布的几种画面共用的图框：按分镜画幅放在标注工具条与版本条之间。 */
function Hero({
  aspectRatio,
  children,
  className,
}: {
  aspectRatio: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className="image-edit-hero-wrap">
      <div
        className={cn('image-edit-hero', className)}
        style={{ '--image-edit-ratio': aspectValueOf(aspectRatio) } as CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}

/** 按描述再生成时的舞台：只放在用的那张（没有在用的就空着），不画标注；新的出来进版本条，选用才用上。 */
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
    <div className="image-edit-stage">
      <Hero aspectRatio={aspectRatio}>
        {url == null ? null : <img alt={label} className="image-edit-hero-image" src={url} />}
      </Hero>
    </div>
  )
}

/** 任务提交时的底图，衬在状态胶囊下面；按描述生成的任务没有底图（空串），只留胶囊。 */
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
  const elapsed = useTakeElapsed(since)
  return (
    <span aria-label={`生成中，已用 ${elapsed}`} className="image-edit-pill" role="status">
      <span aria-hidden="true" className="image-edit-pill-dot" />
      生成中
      <span className="text-on-surface-muted tabular-nums">{elapsed}</span>
    </span>
  )
}

/** 失败原因就地展开；原文常是服务端的长响应，只在用户要看时铺开。 */
function FailedPills({ message }: { message: string | undefined }) {
  const [open, setOpen] = useState(false)
  const reasonId = useId()
  useEscapeAheadOfDialog(open, () => setOpen(false))
  return (
    <>
      <span className="image-edit-pill" role="alert">
        <Icon className="text-error" decorative name="alert" size="sm" />
        未成功
      </span>
      {!message ? null : (
        <>
          <button
            aria-controls={reasonId}
            aria-expanded={open}
            className="image-edit-pill image-edit-pill-button ui-focus"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            查看原因
            <Icon decorative name="expand" size="sm" />
          </button>
          <p className="image-edit-reason" hidden={!open} id={reasonId}>
            {message}
          </p>
        </>
      )}
    </>
  )
}

/**
 * 替换与撤销成功后，按下的那个按钮随画面换掉，焦点会落回弹窗本身；把它接到对面那个按钮上，
 * 键盘用户可以接着撤销或再替换。焦点本来就在别处（比如版本条）时不抢。
 *
 * @param ready 按钮可用时才接：写回进行中它是禁用的，接不住。
 */
function useCatchDroppedFocus(target: RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const active = document.activeElement
    if (active === null || active === document.body || active.getAttribute('role') === 'dialog')
      target.current?.focus()
  }, [target, ready])
}

/** 刚替换完：给 6 秒撤销；撤销失败的原因跟在旁边。 */
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

/** 对比时的主操作：把选中的这张换成当前帧。 */
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

/**
 * 当前帧画标注；排队、生成中是模糊的底图加计时胶囊；失败是压暗的底图加原因；
 * 结果与上一版和当前帧左右对比，满意就「替换当前帧」，替换后 6 秒内可撤销。
 * 没有在用的图（制作页没选用的生成图）时没有当前帧可画、可比：结果单独放，主操作是「选用这张」。
 */
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
      <div className="image-edit-stage">
        <p className="image-edit-stage-message" role="alert">
          {words.gone}
        </p>
      </div>
    )

  if (entry === undefined || entry.kind === 'current')
    return (
      <div className="image-edit-stage">
        {currentUrl === null ? (
          <p className="image-edit-stage-message">还没有在用的图，从版本里选一张</p>
        ) : (
          canvas
        )}
        {replace.undoable ? <UndoBar done={words.replaced} replace={replace} /> : null}
      </div>
    )

  if (entry.kind === 'pending') {
    const queued = phaseOfStatus(entry.job.status) === 'queued'
    return (
      <div className="image-edit-stage">
        <Hero aspectRatio={aspectRatio} className="image-edit-hero-blurred">
          <BaseImage key={baseUrl} url={baseUrl} />
          <span aria-hidden="true" className="image-edit-hero-veil" />
          <div className="image-edit-pills">
            {queued ? (
              <span className="image-edit-pill" role="status">
                <Icon className="text-on-surface-muted" decorative name="duration" size="sm" />
                排队中
              </span>
            ) : (
              <RunningPill since={entry.job.createdAt} />
            )}
          </div>
        </Hero>
      </div>
    )
  }

  if (entry.kind === 'failed')
    return (
      <div className="image-edit-stage">
        <Hero aspectRatio={aspectRatio} className="image-edit-hero-failed">
          <BaseImage key={baseUrl} url={baseUrl} />
          <span aria-hidden="true" className="image-edit-hero-veil" />
          <div className="image-edit-pills">
            <FailedPills key={entry.key} message={entry.job.errorMessage?.trim()} />
          </div>
        </Hero>
      </div>
    )

  return (
    <div className="image-edit-stage">
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
    </div>
  )
}
