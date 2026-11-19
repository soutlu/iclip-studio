import type { ReactElement } from 'react'
import { useEnhanceTiers, type EnhanceTierRow } from '@/shared/api/video-enhancements'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import { BlockedReason } from '../components/blocked-reason'
import { phraseWith, SOURCE_LOCALE, type Language } from './locales'
import type { ExportLocale, ExportView } from './use-whole-film-export'

/** 点「导出」导出的是哪种语言：编辑器当前显示的语言，和这种语言里还没翻的文字条数（原文时是 0）。 */
type ExportTarget = { locale: Language; untranslated: number }

type ExportControlProps = {
  view: ExportView
  target: ExportTarget
  /** 为什么现在不能发起导出：给了就把「导出」「重新导出」都禁用，点了说明它。 */
  blocked: string | undefined
  onStart: () => void
  onCancel: () => void
}

type Status = { text: string; tone: 'normal' | 'busy' | 'error' }

/** 状态里的一句话，`before` 和 `after` 之间写导出的是哪种语言的版本（「English 版」「中文版」）；原文不写。 */
const withVersion = (before: string, locale: ExportLocale, after: string) =>
  locale === SOURCE_LOCALE ? `${before}${after}` : phraseWith(before, locale, `版${after}`)

const exportStatus = (view: ExportView): Status | undefined => {
  switch (view.kind) {
    case 'starting':
      return { text: withVersion('正在提交', view.locale, '导出…'), tone: 'normal' }
    case 'queued':
      return {
        text: withVersion(
          '',
          view.locale,
          view.ahead === null || view.ahead === 0
            ? '排队中，即将开始'
            : `排队中，前方还有 ${view.ahead} 个导出`,
        ),
        tone: 'normal',
      }
    case 'rendering':
      return {
        text: withVersion(
          '正在渲染',
          view.locale,
          view.progress === null ? '…' : ` ${Math.round(view.progress * 100)}%`,
        ),
        tone: 'normal',
      }
    case 'uploading':
      return { text: withVersion('正在上传', view.locale, '成片…'), tone: 'normal' }
    case 'failed':
      return { text: view.message, tone: 'error' }
    case 'cancelled':
      return { text: '已取消导出', tone: 'normal' }
    case 'idle':
    case 'done':
      return undefined
  }
}

/** 完成后状态里写导出的是哪种语言的版本；原文不写。高清版在做或失败时先说高清版。 */
const doneStatus = (view: ExportView): Status | undefined =>
  view.kind === 'done' && view.locale !== SOURCE_LOCALE
    ? { text: withVersion('已导出', view.locale, ''), tone: 'normal' }
    : undefined

/** 「导出」「重新导出」的提示：其它语言时说导出哪种语言的版本，还有没翻的文字时提醒一句；原文时没有。 */
const startHint = ({ locale, untranslated }: ExportTarget): string | undefined => {
  if (locale === SOURCE_LOCALE) return undefined
  const version = withVersion('导出', locale, '')
  return untranslated === 0
    ? version
    : `${version}；有 ${untranslated} 条文字未翻译，导出后显示原文`
}

/** 被拦时说明原因（点了才出）；没被拦、有提示时悬停或聚焦显示提示。 */
function StartTip({
  blocked,
  hint,
  children,
}: {
  blocked: string | undefined
  hint: string | undefined
  children: ReactElement
}) {
  if (blocked !== undefined || hint === undefined)
    return (
      <BlockedReason reason={blocked} side="bottom">
        {children}
      </BlockedReason>
    )
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </TooltipRoot>
  )
}

const enhanceStatus = (rows: readonly EnhanceTierRow[]): Status | undefined => {
  const running = rows.find((row) => row.state === 'running')
  if (running !== undefined) return { text: `正在生成高清版 ${running.resolution}`, tone: 'busy' }
  const failed = rows.find((row) => row.state === 'failed')
  if (failed !== undefined)
    return { text: `高清版 ${failed.resolution} 生成失败，请重试`, tone: 'error' }
  return undefined
}

export function ExportControl({ view, target, blocked, onStart, onCancel }: ExportControlProps) {
  const running = view.kind === 'queued' || view.kind === 'rendering' || view.kind === 'uploading'
  const startable = blocked === undefined && view.kind !== 'starting'
  const startIfAllowed = () => {
    if (startable) onStart()
  }
  const hint = startHint(target)
  const rows = useEnhanceTiers(view.kind === 'done' ? view.exportId : undefined)
  const status = exportStatus(view) ?? enhanceStatus(rows) ?? doneStatus(view)
  return (
    <div className="wf-export">
      {status === undefined ? null : (
        <span
          className={status.tone === 'error' ? 'wf-export-status is-error' : 'wf-export-status'}
          role="status"
        >
          {status.tone === 'busy' ? (
            <Icon className="animate-spin" decorative name="spinner" size="xs" />
          ) : null}
          {status.text}
        </span>
      )}
      {running ? (
        <Button onClick={onCancel} size="md" variant="outlined">
          取消导出
        </Button>
      ) : view.kind === 'done' ? (
        <>
          <StartTip blocked={blocked} hint={hint}>
            <Button
              aria-disabled={blocked === undefined ? undefined : true}
              onClick={startIfAllowed}
              size="md"
              variant="ghost"
            >
              重新导出
            </Button>
          </StartTip>
          <VideoDownload
            className="editor-compose"
            enhanceSourceId={view.exportId}
            jobId={view.exportId}
            originalLabel="下载成片"
            url={view.downloadUrl}
            watermarkUrl={null}
          >
            下载成片
          </VideoDownload>
        </>
      ) : (
        <StartTip blocked={blocked} hint={hint}>
          <Button
            aria-disabled={startable ? undefined : true}
            className="editor-compose"
            leadingIcon="final-cut-export"
            loading={view.kind === 'starting'}
            onClick={startIfAllowed}
            size="md"
          >
            导出
          </Button>
        </StartTip>
      )}
    </div>
  )
}
