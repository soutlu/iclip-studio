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
import { Button } from '@/shared/ui/button'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { StageBackdrop } from '../components/stage-backdrop'
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

/** 不是画布的几种画面共用的图框：按分镜画幅放在标注工具条与版本条之间，圆角投影与画布上的图一致。 */
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

/** 舞台：底下铺舞台上那张图的模糊放大版（没有图时不铺），上面放画面与操作。 */
function Stage({ backdrop, children }: { backdrop: string | undefined; children: ReactNode }) {
  return (
    <div className="image-edit-stage">
      <StageBackdrop url={backdrop === '' ? undefined : backdrop} />
      {children}
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
    <Stage backdrop={url ?? undefined}>
      <Hero aspectRatio={aspectRatio}>
        {url == null ? null : <img alt={label} className="image-edit-hero-image" src={url} />}
      </Hero>
    </Stage>
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

/** 失败原因就地展开在胶囊下面；原文常是服务端的长响应，只在用户要看时铺开。 */
function FailedPills({ message }: { message: string | undefined }) {
  const [open, setOpen] = useState(false)
  const reasonId = useId()
  useEscapeAheadOfDialog(open, () => setOpen(false))
  return (
    <>
      <div className="image-edit-status-row">
        <span className="image-edit-pill" role="alert">
          <Icon className="text-error" decorative name="alert" size="sm" />
          生成失败
        </span>
        {!message ? null : (
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
        )}
      </div>
      {!message ? null : (
        <p className="image-edit-reason" hidden={!open} id={reasonId}>
          {message}
        </p>
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
 * 当前帧画标注；排队、生成中是压暗的底图，计时胶囊在正中；失败压得更暗，胶囊与原因在正中；
 * 结果与上一版和当前帧左右对比，满意就「替换当前帧」，替换后 6 秒内可撤销。
 * 没有在用的图（制作页没选用的生成图）时没有当前帧可画、可比：结果单独放，主操作是「选用这张」。
 * 舞台底的模糊图取舞台上那一张：画布与在途、失败是底图，对比是结果。
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
          <span aria-hidden="true" className="image-edit-hero-dim" />
          <div className="image-edit-status">
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
      </Stage>
    )
  }

  if (entry.kind === 'failed')
    return (
      <Stage backdrop={baseUrl}>
        <Hero aspectRatio={aspectRatio}>
          <BaseImage key={baseUrl} url={baseUrl} />
          <span aria-hidden="true" className="image-edit-hero-dim" data-failed="" />
          <div className="image-edit-status">
            <FailedPills key={entry.key} message={entry.job.errorMessage?.trim()} />
          </div>
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
