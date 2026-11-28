import { useState, type ReactElement } from 'react'
import { useEnhanceTiers, type EnhanceTierRow } from '@/shared/api/video-enhancements'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import { BlockedReason } from '../components/blocked-reason'
import { tierLabel, type ExportTier } from './composition/export-resolution'
import { phraseAround, phraseWith, SOURCE_LOCALE, type Language } from './locales'
import type { ExportVersion, ExportView } from './use-whole-film-export'

/** 要导出的语言里配音没跟上的句数：`stale` 是还是旧配音（过期）的，`missing` 是要配还没配的。 */
type DubGaps = { stale: number; missing: number }

/**
 * 导出目标配置：当前展示语言、该语言下尚未翻译的文本条数（原文恒为 0）、导出分辨率档位（按画布原尺寸导出时为
 * `null`）以及配音没跟上的句数。
 */
type ExportTarget = {
  locale: Language
  untranslated: number
  resolution: ExportTier | null
  dubs: DubGaps
}

type ExportControlProps = {
  view: ExportView
  target: ExportTarget
  /** 禁止发起导出时的原因说明；非空时禁用「导出」与「重新导出」并在点击时提示。 */
  blocked: string | undefined
  onStart: () => void
  onCancel: () => void
  /** 导出提醒里的「去重配」：切到「字幕」页签的当前语言。 */
  onFixDubs: () => void
}

/** 配音没跟上时的提醒：几句还是旧配音、几句没有配音，导出照现在的样子出；都跟上了时是 undefined。不拦导出。 */
const dubNote = ({ stale, missing }: DubGaps): string | undefined => {
  const parts = [
    stale === 0 ? null : `${stale} 句还是旧配音`,
    missing === 0 ? null : `${missing} 句没有配音`,
  ].filter((part) => part !== null)
  const results = [
    stale === 0 ? null : '旧配音照旧',
    missing === 0 ? null : '没有配音的句子不出声',
  ].filter((part) => part !== null)
  return parts.length === 0 ? undefined : `有 ${parts.join('、')}，导出时${results.join('、')}`
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
 * 「导出」与「重新导出」按钮的悬停提示：说明目标版本（原文且按画布原尺寸导出时省略），存在未翻译文本时提示条数，
 * 配音没跟上时接上配音提醒（见 `dubNote`）；都没有时是 undefined。
 */
const startHint = ({
  locale,
  untranslated,
  resolution,
  dubs,
}: ExportTarget): string | undefined => {
  const parts = [
    locale === SOURCE_LOCALE && resolution === null
      ? null
      : withVersion('导出', { locale, resolution }, ''),
    untranslated === 0 ? null : `有 ${untranslated} 条文字未翻译，导出后显示原文`,
    dubNote(dubs) ?? null,
  ].filter((part) => part !== null)
  return parts.length === 0 ? undefined : parts.join('；')
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

/**
 * 顶栏的导出：状态文字、「导出」（导出中是「取消导出」，导出完是「重新导出」和「下载成片」）。配音没跟上时悬停提示里
 * 写明，点了照常导出，同时在下面弹一个提醒（同一句话和「去重配」），Esc、点外面收起。
 */
export function ExportControl({
  view,
  target,
  blocked,
  onStart,
  onCancel,
  onFixDubs,
}: ExportControlProps) {
  const running = view.kind === 'queued' || view.kind === 'rendering' || view.kind === 'uploading'
  const startable = blocked === undefined && view.kind !== 'starting'
  const note = dubNote(target.dubs)
  const [noting, setNoting] = useState(false)
  const startIfAllowed = () => {
    if (!startable) return
    onStart()
    if (note !== undefined) setNoting(true)
  }
  const hint = startHint(target)
  const rows = useEnhanceTiers(view.kind === 'done' ? view.exportId : undefined)
  const status = exportStatus(view) ?? enhanceStatus(rows) ?? doneStatus(view)
  return (
    <PopupRoot onOpenChange={setNoting} open={noting && note !== undefined}>
      <PopupAnchor asChild>
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
      </PopupAnchor>
      {note === undefined ? null : (
        <PopupSurface
          align="end"
          aria-label="配音提醒"
          className="wf-menu wf-export-note"
          collisionPadding={16}
          side="bottom"
          sideOffset={8}
        >
          <p className="wf-export-note-text">{note}</p>
          <button
            className="wf-chip-btn is-tonal ui-state ui-focus"
            onClick={() => {
              setNoting(false)
              onFixDubs()
            }}
            type="button"
          >
            去重配
          </button>
        </PopupSurface>
      )}
    </PopupRoot>
  )
}
