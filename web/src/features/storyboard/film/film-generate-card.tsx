/** 舞台上一张还没有图的生成图：照发给模型的描述画出来，参考图在它出现的位置是图片芯片（编号与舞台、正文同一套），
 * 还没有图的参考图后端只用文字写；底下一个「生成这张」。在生成就是转圈加已用时长，失败写原因、按钮变「重新生成」。
 * 结果落定后后端直接用上它，制作页随生成状态帧重读，舞台换成那张图。 */

import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import type { GenerationJob } from '../storyboard.api'
import { isRunningStatus } from '../shots'
import { useTakeElapsed } from '../components/use-take-elapsed'
import type { FilmFrame, FilmGroup } from './film.api'
import { frameTag, missingImageText } from './film-content'
import { FilmImageChip } from './film-image-chip'

type FilmGenerateCardProps = {
  group: FilmGroup
  frame: FilmFrame
  /** 这张图最近一次按描述生成的任务。 */
  job: GenerationJob | undefined
  /** 只读时没有按钮。 */
  readOnly: boolean
  /** 正在提交（还没拿到任务号）。 */
  submitting: boolean
  /** 上次提交没被收下的原话。 */
  error: string | undefined
  onGenerate: () => void
  onEnlarge: (url: string, label: string) => void
}

export function FilmGenerateCard({
  error,
  frame,
  group,
  job,
  onEnlarge,
  onGenerate,
  readOnly,
  submitting,
}: FilmGenerateCardProps) {
  if (job !== undefined && isRunningStatus(job.status)) return <Generating since={job.createdAt} />
  const failed = job?.status === 'failed'
  // 提交没被收下的原话优先；其次是上次生成失败的原因。
  const reason = error ?? (failed ? (job.errorMessage ?? '这次没生成出来') : undefined)
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
        {readOnly ? null : (
          <div className="film-generate-foot">
            {reason === undefined ? null : (
              <p className="film-generate-error" role="alert">
                {reason}
              </p>
            )}
            <Button
              className="ml-auto rounded-full"
              disabled={submitting}
              leadingIcon="image"
              onClick={onGenerate}
              size="md"
            >
              {submitting ? '提交中…' : failed ? '重新生成' : '生成这张'}
            </Button>
          </div>
        )}
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
