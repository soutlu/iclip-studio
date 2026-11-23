import type { ReactElement } from 'react'
import { useEnhanceTiers, type EnhanceTierRow } from '@/shared/api/video-enhancements'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import { BlockedReason } from '../components/blocked-reason'
import { tierLabel, type ExportTier } from './composition/export-resolution'
import { phraseAround, phraseWith, SOURCE_LOCALE, type Language } from './locales'
import type { ExportVersion, ExportView } from './use-whole-film-export'

/**
 * 导出目标配置：当前展示语言、该语言下尚未翻译的文本条数（原文恒为 0）以及导出分辨率档位（按画布原尺寸导出时为 `null`）。
 */
type ExportTarget = { locale: Language; untranslated: number; resolution: ExportTier | null }

type ExportControlProps = {
  view: ExportView
  target: ExportTarget
  /** 禁止发起导出时的原因说明；非空时禁用「导出」与「重新导出」并在点击时提示。 */
  blocked: string | undefined
  onStart: () => void
  onCancel: () => void
}

type Status = { text: string; tone: 'normal' | 'busy' | 'error' }

/**
 * 拼装包含目标版本信息的状态文案：在 `before` 与 `after` 之间插入语言版本（如「English 版」「中文版」，原文省略）
 * 与分辨率档位（如「720P」，按画布原尺寸导出省略）。
 */
const withVersion = (before: string, { locale, resolution }: ExportVersion, after: string) => {
  const tiered = (head: string) =>
    resolution === null ? `${head}${after}` : phraseAround(head, tierLabel(resolution), after)
  return locale === SOURCE_LOCALE ? tiered(before) : phraseWith(before, locale, tiered('版'))
}

const exportStatus = (view: ExportView): Status | undefined => {
  switch (view.kind) {
    case 'starting':
      return { text: withVersion('正在提交', view, '导出…'), tone: 'normal' }
    case 'queued':
      return {
        text: withVersion(
          '',
          view,
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
          view,
          view.progress === null ? '…' : ` ${Math.round(view.progress * 100)}%`,
        ),
        tone: 'normal',
      }
    case 'uploading':
      return { text: withVersion('正在上传', view, '成片…'), tone: 'normal' }
    case 'failed':
      return { text: view.message, tone: 'error' }
    case 'cancelled':
      return { text: '已取消导出', tone: 'normal' }
    case 'idle':
    case 'done':
      return undefined
  }
}

/** 导出完成时的版本状态说明；原文且按画布原尺寸导出时省略。 */
const doneStatus = (view: ExportView): Status | undefined =>
  view.kind === 'done' && (view.locale !== SOURCE_LOCALE || view.resolution !== null)
    ? { text: withVersion('已导出', view, ''), tone: 'normal' }
    : undefined

/**
 * 「导出」与「重新导出」按钮的悬停提示：说明目标版本并在存在未翻译文本时提示条数；原文且按画布原尺寸导出时省略。
 */
const startHint = ({ locale, untranslated, resolution }: ExportTarget): string | undefined => {
  if (locale === SOURCE_LOCALE && resolution === null) return undefined
  const version = withVersion('导出', { locale, resolution }, '')
  return untranslated === 0
    ? version
    : `${version}；有 ${untranslated} 条文字未翻译，导出后显示原文`
}

/** 禁用时在点击后展示阻断原因；可用且存在提示时在悬停或聚焦时展示提示。 */
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
