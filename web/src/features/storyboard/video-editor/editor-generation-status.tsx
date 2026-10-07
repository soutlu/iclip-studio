import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { GenerationJob } from '../storyboard.api'
import type { PendingEdit } from './edit-chain'
import './editor-generation-status.css'

type EditorGenerationStatusProps = { edit: PendingEdit }
type StepState = 'completed' | 'current' | 'pending' | 'failed'

const STEPS = ['排队提交', '视频生成', '结果预览'] as const
const STEP_STATES: Record<StepState, string> = {
  completed: '已完成',
  current: '当前阶段',
  pending: '等待中',
  failed: '失败',
}

/** 合成的处境：`queued` 是还在本系统排队，其余是后端报的加工阶段。 */
type ClipProgress = 'queued' | NonNullable<GenerationJob['clipStage']>

const COMPOSING_TITLES: Record<ClipProgress, string> = {
  queued: '等待合成',
  fetching: '正在取素材',
  processing: '正在编码成片',
  uploading: '正在上传成片',
}

/** 排队中还没人动它，阶段词要到提交中才有；读不到就让调用方回落。 */
const composingTitleOf = (job: GenerationJob | undefined) => {
  if (job === undefined) return undefined
  const progress = job.status === 'pending' ? 'queued' : job.clipStage
  return progress === null ? undefined : COMPOSING_TITLES[progress]
}

function describeProgress(edit: PendingEdit) {
  switch (edit.stage) {
    case 'queued':
      // 参考片段提交前已在浏览器里切好、传好，这一步只剩排队与交给模型。
      return {
        step: 0,
        title: edit.video.status === 'pending' ? '排队等待中' : '正在提交给模型',
      }
    case 'generating':
      return { step: 1, title: '正在生成视频' }
    case 'ready':
      return { step: 2, title: '待预览' }
    case 'composing':
      return {
        step: 2,
        title: composingTitleOf(edit.composite) ?? '正在合成成片',
      }
    case 'failed':
      // 编辑段提交失败与生成失败落在同一条记录上，记录分不出是哪一步，一律记在视频生成这一步。
      return edit.composite !== undefined && edit.composite.status !== 'completed'
        ? { step: 2, title: '成片合成失败' }
        : { step: 1, title: '视频生成失败' }
  }
}

/** 展示真实编辑阶段；结果就绪后等待用户预览，不将生成完成视为已经合成。 */
export function EditorGenerationStatus({ edit }: EditorGenerationStatusProps) {
  const progress = describeProgress(edit)
  const failed = edit.stage === 'failed'
  const ready = edit.stage === 'ready'

  return (
    <div
      aria-label="视频编辑进度"
      aria-live="polite"
      className="video-editor-generation-status"
      data-state={failed ? 'failed' : ready ? 'ready' : 'running'}
      role="status"
    >
      <div className="video-editor-generation-status-header">
        <span className="video-editor-generation-status-version">{edit.label}</span>
        <Icon
          className={cn(!failed && !ready && 'animate-spin motion-reduce:animate-none')}
          decorative
          name={failed ? 'failed' : ready ? 'success' : 'loading'}
          size="sm"
        />
        <strong>{progress.title}</strong>
      </div>
      {failed && edit.error ? (
        <p className="video-editor-generation-status-detail">{edit.error}</p>
      ) : null}
      <ol aria-label="生成阶段" className="video-editor-generation-status-steps">
        {STEPS.map((label, index) => {
          const state: StepState =
            index < progress.step
              ? 'completed'
              : index > progress.step
                ? 'pending'
                : failed
                  ? 'failed'
                  : 'current'
          return (
            <li
              aria-current={index === progress.step ? 'step' : undefined}
              aria-label={`${label}，${STEP_STATES[state]}`}
              data-state={state}
              key={label}
            >
              <span className="video-editor-generation-status-step-mark">
                {state === 'completed' || state === 'failed' ? (
                  <Icon decorative name={state === 'completed' ? 'check' : 'close'} size="xs" />
                ) : null}
              </span>
              <span>{label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
