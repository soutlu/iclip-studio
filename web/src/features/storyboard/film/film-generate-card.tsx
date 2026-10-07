/** 舞台上一张没有图（没选用）的生成图，按它最近一次按描述生成的任务分四种：
 * - 从没生成过：照发给模型的描述画出来，参考图在它出现的位置是图片芯片（编号与舞台、正文同一套），没有图的参考图后端只用
 *   文字写；底下「生成这张」。
 * - 在生成：转圈加已用时长。
 * - 失败：描述照旧，写原因，按钮变「重新生成」。
 * - 生成好了还没选用：放那次结果的预览，底下「再生成」与「选用这张」；生成不会自动用上，选用了舞台才换成它。
 * 有按钮时，按钮上方一行写它挂的参考图里哪几张没有图、只用描述（`missing`），只提醒不拦。 */

import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import type { GenerationJob } from '../storyboard.api'
import { isRunningStatus } from '../shots'
import { useTakeElapsed } from '../components/use-take-elapsed'
import type { FilmFrame, FilmGroup } from './film.api'
import {
  frameTag,
  missingImageText,
  missingReferencesText,
  unselectedImageText,
} from './film-content'
import { FilmImageChip } from './film-image-chip'

/** 卡上正在提交的那件事：按描述生成，或选用那次结果。 */
export type GenerateCardBusy = 'generate' | 'choose' | null

type FilmGenerateCardProps = {
  group: FilmGroup
  frame: FilmFrame
  /** 这张图最近一次按描述生成的任务。 */
  job: GenerationJob | undefined
  /** 只读时没有按钮。 */
  readOnly: boolean
  /** 正在提交的那件事；提交完（拿到任务号或选用写好）回到 null。 */
  busy: GenerateCardBusy
  /** 上次提交没被收下的原话。 */
  error: string | undefined
  onGenerate: () => void
  /** 选用这次生成出来的 `url`。 */
  onChoose: (url: string) => void
  onEnlarge: (url: string, label: string) => void
}

export function FilmGenerateCard({
  busy,
  error,
  frame,
  group,
  job,
  onChoose,
  onEnlarge,
  onGenerate,
  readOnly,
}: FilmGenerateCardProps) {
  if (job !== undefined && isRunningStatus(job.status)) return <Generating since={job.createdAt} />
  const result = job?.status === 'completed' ? (job.outputUrl ?? undefined) : undefined
  const failed = job?.status === 'failed'
  // 提交没被收下的原话优先；其次是上次生成失败的原因。
  const reason = error ?? (failed ? (job.errorMessage ?? '这次没生成出来') : undefined)
  const hint = missingReferencesText(frame.missing)
  const foot = readOnly ? null : (
    <>
      {hint === undefined ? null : (
        <p className="film-generate-hint">
          <Icon decorative name="info" size="xs" />
          <span>{hint}</span>
        </p>
      )}
      <div className="film-generate-foot">
        {reason === undefined ? null : (
          <p className="film-generate-error" role="alert">
            {reason}
          </p>
        )}
        {result === undefined ? (
          <Button
            className="ml-auto rounded-full"
            disabled={busy !== null}
            leadingIcon="image"
            onClick={onGenerate}
            size="md"
          >
            {busy === 'generate' ? '提交中…' : failed ? '重新生成' : '生成这张'}
          </Button>
        ) : (
          <>
            <Button
              className="ml-auto rounded-full"
              disabled={busy !== null}
              leadingIcon="refresh"
              onClick={onGenerate}
              size="md"
              variant="outlined"
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
              {busy === 'choose' ? '正在选用…' : '选用这张'}
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
            aria-label={`放大看${frame.label}的生成结果`}
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
        <h3 className="film-generate-title">{missingImageText(frame.label)}</h3>
        <p className="film-generate-prompt">
          {(frame.prompt ?? []).map((run, index) => {
            if (run.kind !== 'image') return run.text
            const used = group.frames.find((item) => item.node === run.node)
            return (
              <FilmImageChip
                // 描述按出现的先后排，同一张图可以出现几次，没有别的身份。
                key={`${run.node}@${String(index)}`}
                label={run.label}
                onEnlarge={(url) => onEnlarge(url, run.label)}
                tag={used === undefined ? run.label : frameTag(used)}
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
  const elapsed = useTakeElapsed(since)
  return (
    <div aria-label={`生成中，已用 ${elapsed}`} className="storyboard-take-stage" role="status">
      <span className="storyboard-take-shine" />
      <Icon className="animate-spin" decorative name="spinner" size="lg" />
      <span className="tabular-nums">生成中 · {elapsed}</span>
    </div>
  )
}
