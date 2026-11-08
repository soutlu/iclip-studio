import { useId } from 'react'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import type { GenerationJob } from '../storyboard.api'
import { isRunningStatus } from '../shots'
import { AspectGlyph } from '../components/aspect-glyph'
import { useElapsed } from '@/shared/ui/media-preview'
import type { FilmFrame } from './film.api'
import { missingReferencesText, unselectedImageText } from './film-content'
import { FilmImageChip } from './film-image-chip'

export type GenerateCardBusy = 'generate' | 'choose' | null

type FilmGenerateCardProps = {
  frame: FilmFrame
  job: GenerationJob | undefined
  readOnly: boolean
  busy: GenerateCardBusy
  error: string | undefined
  onGenerate: () => void
  onChoose: (url: string) => void
  onEnlarge: (url: string, label: string) => void
}

export function FilmGenerateCard({
  busy,
  error,
  frame,
  job,
  onChoose,
  onEnlarge,
  onGenerate,
  readOnly,
}: FilmGenerateCardProps) {
  const blockerId = useId()
  if (job !== undefined && isRunningStatus(job.status)) return <Generating since={job.createdAt} />
  const result = job?.status === 'completed' ? (job.outputUrl ?? undefined) : undefined
  const failed = job?.status === 'failed'
  const reason = error ?? (failed ? (job.errorMessage ?? '本次生成失败') : undefined)
  const blocker = missingReferencesText(frame.missing)
  const generateProps = {
    'aria-describedby': blocker === undefined ? undefined : blockerId,
    disabled: busy !== null || blocker !== undefined,
    onClick: onGenerate,
  }
  const foot = (
    <>
      {readOnly || blocker === undefined ? null : (
        <p className="film-generate-hint" id={blockerId}>
          <Icon decorative name="info" size="xs" />
          <span>{blocker}</span>
        </p>
      )}
      <div className="film-generate-foot">
        {frame.aspectRatio === null ? null : (
          <span className="storyboard-bar-control storyboard-bar-picker" data-fixed="">
            <span className="sr-only">图片比例</span>
            <AspectGlyph longSide={13} ratio={frame.aspectRatio} />
            <span className="storyboard-bar-picker-text">{frame.aspectRatio}</span>
          </span>
        )}
        {readOnly || reason === undefined ? null : (
          <p className="film-generate-error" role="alert">
            {reason}
          </p>
        )}
        {readOnly ? null : result === undefined ? (
          <Button className="ml-auto rounded-full" leadingIcon="image" size="md" {...generateProps}>
            {busy === 'generate' ? '提交中…' : failed ? '重新生成' : '生成图片'}
          </Button>
        ) : (
          <>
            <Button
              className="ml-auto rounded-full"
              leadingIcon="refresh"
              size="md"
              variant="outlined"
              {...generateProps}
            >
              {busy === 'generate' ? '提交中…' : '再生成'}
            </Button>
            <Button
              className="rounded-full"
              disabled={busy !== null}
              leadingIcon="check"
              onClick={() => onChoose(result)}
              size="md"
              variant="inverted"
            >
              {busy === 'choose' ? '正在选用…' : '选用该图片'}
            </Button>
          </>
        )}
      </div>
    </>
  )
  if (result !== undefined)
    return (
      <div className="film-generate">
        <section
          aria-label={`${frame.label}的生成结果`}
          className="film-generate-card"
          data-result=""
        >
          <h3 className="film-generate-title">{unselectedImageText(frame.label)}</h3>
          <button
            aria-label={`放大查看${frame.label}的生成结果`}
            className="film-generate-preview ui-focus"
            onClick={() => onEnlarge(result, frame.label)}
            type="button"
          >
            <img alt="" src={result} />
          </button>
          {foot}
        </section>
      </div>
    )
  return (
    <div className="film-generate">
      <section aria-label={`${frame.label}的生图描述`} className="film-generate-card">
        <h3 className="film-generate-title">{frame.label} · 图像生成</h3>
        <p className="film-generate-prompt">
          {(frame.prompt ?? []).map((run, index) => {
            if (run.kind !== 'image') return run.text
            return (
              <FilmImageChip
                key={`${run.node}@${String(index)}`}
                label={run.label}
                onEnlarge={(url) => onEnlarge(url, run.label)}
                tag={`@${String(run.number)}`}
                url={run.url}
              />
            )
          })}
        </p>
        {foot}
      </section>
    </div>
  )
}

function Generating({ since }: { since: string }) {
  const elapsed = useElapsed(since)
  return (
    <div className="storyboard-hero">
      <div aria-label={`生成中，已用 ${elapsed}`} className="storyboard-take-stage" role="status">
        <span className="storyboard-take-shine" />
        <Icon className="animate-spin" decorative name="spinner" size="lg" />
        <span className="tabular-nums">生成中 · {elapsed}</span>
      </div>
    </div>
  )
}
