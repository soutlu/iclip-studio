/** 按任务执行次数：一段对话一行，接口排序与翻页；异常只用图标放在对应那项数据前，点整行展开镜头带与按模型用量。 */

import { Link } from '@tanstack/react-router'
import { Fragment, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { ANOMALY_META, anomalyText } from '../anomaly-kinds'
import type {
  Execution,
  ExecutionAnomalyKind,
  ExecutionSort,
  ExecutionSortKey,
  ExecutionThresholds,
} from '../audit.api'
import { EMPTY, fmtCount, fmtDuration, fmtMoment, fmtRate, fmtTokens } from '../overview-format'
import { ShotStrip } from './shot-strip'
import { CLIP_TD, SortHeader, TableScroll, TD, TH } from './table-bits'

type ExecutionsTableProps = {
  executions: readonly Execution[]
  thresholds: ExecutionThresholds
  sort: ExecutionSort
  onSort: (key: ExecutionSortKey) => void
  nameOf: (userName: string) => string | undefined
}

const COLUMNS = 9

export function ExecutionsTable({
  executions,
  thresholds,
  sort,
  onSort,
  nameOf,
}: ExecutionsTableProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (conversationId: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(conversationId)) next.add(conversationId)
      return next
    })
  return (
    <TableScroll>
      <table aria-label="按任务执行次数" className="w-full border-collapse text-body">
        <thead>
          <tr>
            <SortHeader column="start" onSort={onSort} sort={sort}>
              开始
            </SortHeader>
            <th className={cn(TH, 'text-left')} scope="col">
              对话
            </th>
            <th className={cn(TH, 'text-left')} scope="col">
              人
            </th>
            <th className={cn(TH, 'text-left')} scope="col">
              需求单
            </th>
            <th className={TH} scope="col">
              成片
            </th>
            <SortHeader column="retries" onSort={onSort} sort={sort}>
              每镜头重试次数
            </SortHeader>
            <SortHeader column="cycle" onSort={onSort} sort={sort}>
              运行时长
            </SortHeader>
            <SortHeader column="tokens" onSort={onSort} sort={sort}>
              token 消耗
            </SortHeader>
            <th className={TH} scope="col">
              <span className="sr-only">展开</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {executions.map((execution) => (
            <ExecutionRow
              execution={execution}
              key={execution.conversationId}
              nameOf={nameOf}
              onToggle={() => toggle(execution.conversationId)}
              open={open.has(execution.conversationId)}
              thresholds={thresholds}
            />
          ))}
        </tbody>
      </table>
    </TableScroll>
  )
}

type ExecutionRowProps = {
  execution: Execution
  thresholds: ExecutionThresholds
  open: boolean
  onToggle: () => void
  nameOf: (userName: string) => string | undefined
}

function ExecutionRow({ execution, thresholds, open, onToggle, nameOf }: ExecutionRowProps) {
  const { metrics } = execution
  const flag = (kind: ExecutionAnomalyKind) =>
    execution.anomalies.includes(kind) ? <AnomalyFlag kind={kind} thresholds={thresholds} /> : null
  const person =
    execution.userName === null ? EMPTY : (nameOf(execution.userName) ?? execution.userName)
  const task = execution.taskTitle ?? '无'
  const delivered = execution.deliveredAt !== null

  // 点整行展开或收起；点行里的对话名是打开对话，不展开。
  const onClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.target instanceof Element && event.target.closest('a, button') !== null) return
    onToggle()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onToggle()
  }

  return (
    <Fragment>
      <tr
        aria-expanded={open}
        aria-label={`${execution.title}，${open ? '收起' : '展开'}镜头与模型用量`}
        className="group/row cursor-pointer ui-focus hover:bg-state-hover"
        onClick={onClick}
        onKeyDown={onKeyDown}
        tabIndex={0}
      >
        <td className={TD}>{fmtMoment(new Date(execution.startedAt))}</td>
        <td className={cn(TD, CLIP_TD, 'w-[30%] min-w-40')}>
          <div className="flex min-w-0 items-center">
            {execution.deletedAt === null ? null : <DeletedMark />}
            <Link
              className="min-w-0 truncate text-on-surface ui-focus hover:underline"
              params={{ conversationId: execution.conversationId }}
              title={execution.title}
              to="/c/$conversationId"
            >
              {execution.title}
            </Link>
          </div>
        </td>
        <td className={cn(TD, 'text-left')}>{person}</td>
        <td className={cn(TD, CLIP_TD, 'w-[20%] min-w-28')}>
          <div className="flex min-w-0 items-center">
            {flag('task_stuck')}
            <span className="min-w-0 truncate" title={task}>
              {task}
            </span>
          </div>
        </td>
        <td className={TD}>
          {flag('stuck')}
          {delivered ? '是' : '否'}
        </td>
        <td className={TD}>
          {flag('retry')}
          {metrics.attemptsPerShot === null ? EMPTY : metrics.attemptsPerShot.toFixed(1)}
        </td>
        <td className={TD}>
          {delivered ? fmtDuration(metrics.activeCycleSeconds?.avg ?? null) : EMPTY}
        </td>
        <td className={TD}>
          {flag('spend')}
          {fmtTokens(metrics.usage.totalTokens)}
        </td>
        <td className={cn(TD, 'w-9 pr-0')}>
          <span
            aria-hidden
            className="inline-grid size-7 place-items-center rounded-full align-middle text-on-surface-muted group-hover/row:text-on-surface"
          >
            <Icon
              className={cn('transition-transform ui-motion-s', open && 'rotate-180')}
              decorative
              name="expand"
              size="md"
            />
          </span>
        </td>
      </tr>
      {open ? (
        <tr className="group/row">
          <td
            className={cn(
              TD,
              'bg-state-active px-4 pt-3 pb-3.5 text-left whitespace-normal first:pl-4',
            )}
            colSpan={COLUMNS}
          >
            <ShotStrip retryAtLeast={thresholds.retryAtLeast} shots={execution.shots} />
            <UsageList usage={execution.usage} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}

/** 按模型的用量：一个模型一行。 */
function UsageList({ usage }: { usage: Execution['usage'] }) {
  if (usage.length === 0) return null
  return (
    <ul
      aria-label="按模型用量"
      className="mt-2.5 flex flex-col gap-1 text-label text-on-surface-muted tabular-nums"
    >
      {usage.map((item) => (
        <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1" key={item.modelName}>
          <code className="min-w-22 font-mono text-on-surface-variant">{item.modelName}</code>
          <span>{fmtTokens(item.usage.totalTokens)} token</span>
          <span>缓存命中 {fmtRate(item.usage.cacheHitRate)}</span>
          <span>调用 {fmtCount(item.usage.requests)} 次</span>
        </li>
      ))}
    </ul>
  )
}

const TONE_CLASS = { bad: 'text-error', warn: 'text-warning' } as const
const TONE_ICON = { bad: 'alert', warn: 'warning' } as const

/** 异常图标：悬停看是哪种、门槛多少；读屏读同一句话。 */
function AnomalyFlag({
  kind,
  thresholds,
}: {
  kind: ExecutionAnomalyKind
  thresholds: ExecutionThresholds
}) {
  const text = anomalyText(kind, thresholds)
  const { tone } = ANOMALY_META[kind]
  return (
    <MarkTip text={text}>
      <span
        aria-label={text}
        className={cn(
          'mr-1 inline-grid size-3.5 shrink-0 place-items-center align-[-2px]',
          TONE_CLASS[tone],
        )}
        role="img"
      >
        <Icon decorative name={TONE_ICON[tone]} size="sm" />
      </span>
    </MarkTip>
  )
}

function DeletedMark() {
  return (
    <MarkTip text="这段对话已删除">
      <span
        aria-label="已删除"
        className="mr-1 inline-grid size-3.5 shrink-0 place-items-center text-on-surface-muted"
        role="img"
      >
        <Icon decorative name="delete" size="sm" />
      </span>
    </MarkTip>
  )
}

function MarkTip({ text, children }: { text: string; children: ReactElement }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-70 rounded-md px-3 py-2.5 text-body-sm">
        {text}
      </TooltipContent>
    </TooltipRoot>
  )
}
