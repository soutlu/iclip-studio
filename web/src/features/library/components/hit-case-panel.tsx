/** 查看器的「爆款素材」页签：针对当前选中的那一版。没入选时先选人工维度的标签再加入，进不了时按钮置灰并提示原因；
 * 入选后看打标状态、改全部维度的标签、重新打标、移出。确认沿用底栏原地确认的写法。 */

import { useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button } from '@/shared/ui/button'
import { ListError } from '@/shared/ui/list-state'
import { toast } from '@/shared/ui/toast'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { HIT_CASE_AI_HINT, INELIGIBLE_HINTS } from '../hit-case-labels'
import {
  useAddHitCase,
  useHitCaseState,
  useRemoveHitCase,
  useReplaceHitCaseTags,
  useRetagHitCase,
  type HitCaseEntry,
  type HitCaseIneligible,
} from '../hit-cases.api'
import { isAiDimension, type TagIndex } from '../library-tags'
import { useLibraryTags } from '../library-tags.api'
import { taggingFailureOf } from '../reference-labels'
import { isTaggingBusy } from '../references.api'
import { LibraryTagEditor } from './library-tag-editor'

const INTRO = '爆款素材库收录可供复用的素材片；加入后，AI 将按所在对话的新片执行方案自动打标签。'

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409

export function HitCasePanelSkeleton() {
  return (
    <div aria-label="正在读取爆款素材状态" className="grid gap-3" role="status">
      <span className="h-4 w-4/5 animate-pulse rounded-xs bg-surface-container" />
      <span className="h-4 w-3/5 animate-pulse rounded-xs bg-surface-container" />
      <span className="mt-2 h-(--control-height-lg) animate-pulse rounded-full bg-surface-container" />
    </div>
  )
}

export function HitCasePanel({ jobId }: { jobId: string }) {
  const state = useHitCaseState(jobId)
  const tags = useLibraryTags()
  if (state.isError)
    return (
      <ListError
        message={errorMessageOf(state.error, '读取爆款素材状态失败')}
        onRetry={() => void state.refetch()}
      />
    )
  if (tags.isError)
    return (
      <ListError
        message={errorMessageOf(tags.error, '读取标签失败')}
        onRetry={() => void tags.refetch()}
      />
    )
  if (state.data === undefined || tags.data === undefined) return <HitCasePanelSkeleton />
  const { entry, ineligibleReason } = state.data
  if (entry !== null)
    return <AddedPanel entry={entry} index={tags.data.index} jobId={jobId} key="added" />
  return <AddPanel index={tags.data.index} ineligible={ineligibleReason} jobId={jobId} key="add" />
}

/** 没入选：能入选时先在人工维度上选标签，与「加入爆款素材库」一起提交；进不了时只留置灰的按钮。 */
function AddPanel({
  jobId,
  index,
  ineligible,
}: {
  jobId: string
  index: TagIndex
  ineligible: HitCaseIneligible | null
}) {
  const [draft, setDraft] = useState<string[]>([])
  const add = useAddHitCase(jobId)
  const state = useHitCaseState(jobId)
  // 入选前只让人选人工维度，AI 维度在入选后由打标填上。
  const manual = { ...index, dimensions: index.dimensions.filter((one) => !isAiDimension(one)) }

  const submit = () =>
    add.mutate(draft, {
      onError: (error) => {
        toast.error(errorMessageOf(error, '加入爆款素材库失败'))
        void state.refetch()
      },
      onSuccess: () => toast.success('已加入爆款素材库'),
    })

  return (
    <div className="grid gap-4">
      <p className="text-body-sm text-on-surface-variant">{INTRO}</p>
      {ineligible === null ? (
        <>
          <LibraryTagEditor
            aiHint={HIT_CASE_AI_HINT}
            busy={add.isPending}
            editable
            index={manual}
            onChange={setDraft}
            value={draft}
          />
          <Button
            className="w-full rounded-full"
            leadingIcon="add"
            loading={add.isPending}
            onClick={submit}
            variant="outlined"
          >
            加入爆款素材库
          </Button>
        </>
      ) : (
        <IneligibleButton reason={ineligible} />
      )}
    </div>
  )
}

/** 置灰的「加入爆款素材库」：悬停或点按时说明原因，写法同「做同款」。 */
function IneligibleButton({ reason }: { reason: HitCaseIneligible }) {
  const [hint, setHint] = useState(false)
  return (
    <TooltipRoot onOpenChange={setHint} open={hint}>
      <TooltipTrigger
        asChild
        // 触屏没有悬停，点按也要亮出提示；拦下默认处理，Radix 才不会在点击时把它关掉。
        onClick={(event) => {
          event.preventDefault()
          setHint(true)
        }}
      >
        <Button
          aria-disabled="true"
          className="w-full rounded-full aria-disabled:cursor-default aria-disabled:border-outline-variant aria-disabled:text-on-surface-faint"
          leadingIcon="add"
          variant="outlined"
        >
          加入爆款素材库
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{INELIGIBLE_HINTS[reason]}</TooltipContent>
    </TooltipRoot>
  )
}

type Mode = 'view' | 'confirm-retag' | 'confirm-remove'

/** 已入选：打标状态、全部维度的标签、重新打标与移出。 */
function AddedPanel({
  jobId,
  entry,
  index,
}: {
  jobId: string
  entry: HitCaseEntry
  index: TagIndex
}) {
  const { data: user } = useUser()
  const [mode, setMode] = useState<Mode>('view')
  const state = useHitCaseState(jobId)
  const replace = useReplaceHitCaseTags(jobId)
  const retag = useRetagHitCase(jobId)
  const remove = useRemoveHitCase(jobId)
  const tagging = isTaggingBusy(entry.tagStatus)
  // 没打过标（打标没配置）时不给重新打标；打过的、不在打的才能重打，付费调用另要提交权限。
  const canRetag =
    hasPermission(user, PERMISSION.generationSubmit) &&
    (entry.tagStatus === 'completed' || entry.tagStatus === 'failed')
  const aiDimensions = index.dimensions
    .filter(isAiDimension)
    .map((dimension) => dimension.name)
    .join('、')

  const saveTags = (tagIds: string[]) =>
    replace.mutate(tagIds, {
      onError: (error) => {
        if (isConflict(error)) {
          toast.error('正在打标，标签无法保存；请在打标完成后重试')
          void state.refetch()
        } else toast.error(errorMessageOf(error, '标签保存失败'))
      },
    })

  const confirmRetag = () =>
    retag.mutate(undefined, {
      onError: (error) => {
        if (isConflict(error)) {
          toast.error('该视频正在打标，无法重新打标；请在打标完成后重试')
          void state.refetch()
        } else toast.error(errorMessageOf(error, '重新打标提交失败'))
        setMode('view')
      },
      onSuccess: () => setMode('view'),
    })

  const confirmRemove = () =>
    remove.mutate(undefined, {
      onError: (error) => {
        toast.error(errorMessageOf(error, '移出失败'))
        setMode('view')
      },
      onSuccess: () => toast.success('已移出爆款素材库'),
    })

  const added = formatRelativeTime(entry.addedAt)

  return (
    <div className="grid gap-4">
      <p className="flex items-center gap-1.5 text-body-sm text-on-surface-variant">
        <Icon className="shrink-0" decorative name="check" size="xs" />
        {entry.addedBy === null
          ? `${added}加入爆款素材库`
          : `${added}由 ${entry.addedBy} 加入爆款素材库`}
      </p>
      <div>
        <LibraryTagEditor
          aiHint={HIT_CASE_AI_HINT}
          busy={replace.isPending || tagging}
          editable={mode === 'view'}
          index={index}
          onChange={saveTags}
          value={entry.tagIds}
        />
        <TagStatusLine
          canRetag={canRetag && mode === 'view'}
          entry={entry}
          onRetag={() => setMode('confirm-retag')}
        />
      </div>

      {mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          {canRetag && entry.tagStatus === 'completed' ? (
            <Button
              className="flex-1 rounded-full"
              leadingIcon="tag"
              onClick={() => setMode('confirm-retag')}
              size="md"
              variant="outlined"
            >
              重新打标
            </Button>
          ) : null}
          <Button
            className="flex-1 rounded-full"
            leadingIcon="delete"
            onClick={() => setMode('confirm-remove')}
            size="md"
            variant="outlined"
          >
            移出爆款素材库
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-body-sm text-balance text-on-surface" role="status">
            {mode === 'confirm-remove'
              ? '移出后该视频的标签将一并删除，之后仍可重新加入'
              : aiDimensions === ''
                ? '重新打标会按所在对话当前的新片执行方案重新打标签'
                : `重新打标会按所在对话当前的新片执行方案重写${aiDimensions}的标签，包括手动修改过的内容`}
          </span>
          <Button
            className="shrink-0 rounded-full"
            onClick={() => setMode('view')}
            size="md"
            variant="outlined"
          >
            取消
          </Button>
          <Button
            className="shrink-0 rounded-full disabled:bg-disabled-container"
            loading={mode === 'confirm-remove' ? remove.isPending : retag.isPending}
            onClick={mode === 'confirm-remove' ? confirmRemove : confirmRetag}
            size="md"
            variant="inverted"
          >
            {mode === 'confirm-remove' ? '移出' : '重新打标'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** 标签下面的一行后台状态：正在打标；没打成按原因说一句，能重新打标的人原地点「重新打标」。 */
function TagStatusLine({
  entry,
  canRetag,
  onRetag,
}: {
  entry: HitCaseEntry
  canRetag: boolean
  onRetag: () => void
}) {
  if (isTaggingBusy(entry.tagStatus))
    return (
      <p
        className="mt-3 flex items-center gap-2 text-body-sm text-on-surface-variant"
        role="status"
      >
        <Icon className="shrink-0 animate-spin" decorative name="spinner" size="xs" />
        正在打标，完成后自动更新标签
      </p>
    )
  if (entry.tagStatus !== 'failed') return null
  return (
    <div className="mt-3 flex items-center gap-3" role="alert">
      <p className="flex min-w-0 flex-1 items-start gap-2 text-body-sm text-on-surface">
        <Icon className="mt-1 shrink-0 text-error" decorative name="alert" size="xs" />
        <span className="min-w-0">{taggingFailureOf(entry.tagError, canRetag, 'hit-cases')}</span>
      </p>
      {canRetag ? (
        <Button className="shrink-0 rounded-full" onClick={onRetag} size="md" variant="outlined">
          重新打标
        </Button>
      ) : null}
    </div>
  )
}
