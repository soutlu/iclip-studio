import { useLayoutEffect, useRef } from 'react'
import { useElementSize } from '@/shared/lib/use-element-size'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { Tool } from './editor-toolbar'
import type { Material, MaterialTake, UsedSpan } from './materials'

type TakeHeadProps = {
  take: MaterialTake
  /** 当前展示的版本。 */
  version: Material
  /** 时间线已占用的素材区间映射（按素材地址索引，见 `usedSpans`），用于标识各版本是否已入轨。 */
  used: ReadonlyMap<string, readonly UsedSpan[]>
  /** 镜头数与总时长（毫秒），分镜镜头解析完成后可用。 */
  shotCount: number | undefined
  durationMs: number | undefined
  /** 「+」按钮不可用时的禁用原因说明。 */
  blocked: string | undefined
  onVersion: (takeId: string, jobId: string) => void
  onInsertWhole: () => void
}

/** 原作卡片顶栏：依次展示「出片 A」、版本选择器、「● 已入轨」标识，右侧展示镜头数、总时长及整条加入轨道按钮。 */
export function TakeHead({
  take,
  version,
  used,
  shotCount,
  durationMs,
  blocked,
  onVersion,
  onInsertWhole,
}: TakeHeadProps) {
  return (
    <div className="wf-take-head">
      <span className="wf-take-name">{take.label}</span>
      {take.versions.length > 1 ? (
        <TakeVersions onVersion={onVersion} take={take} used={used} version={version} />
      ) : (
        <span className="wf-take-version">{version.versionNumber}</span>
      )}
      {used.has(version.url) ? (
        <span className="wf-take-in-track">
          <i aria-hidden="true" className="wf-take-dot" />
          已入轨
        </span>
      ) : null}
      <span className="wf-take-meta">
        {shotCount === undefined ? null : <span>{shotCount} 镜</span>}
        {durationMs === undefined ? null : (
          <span className="wf-take-duration">{(durationMs / 1000).toFixed(1)}s</span>
        )}
      </span>
      <Tool
        blocked={blocked}
        className="wf-take-add"
        icon="final-cut-add"
        label="整条加入轨道"
        onClick={onInsertWhole}
        tip="整条加入轨道"
      />
    </div>
  )
}

/** 多版本分段选择器：点击即切换当前展示版本；非当前展示但已入轨的版本附带绿色圆点提示。 */
function TakeVersions({
  take,
  version,
  used,
  onVersion,
}: Pick<TakeHeadProps, 'take' | 'version' | 'used' | 'onVersion'>) {
  const [listRef, { width }] = useElementSize<HTMLDivElement>()
  const currentRef = useRef<HTMLButtonElement>(null)
  // 版本数量超出可用宽度时在分段容器内横向滚动，确保当前选中版本（默认最新版，位于最右）处于视口内；
  // 镜头数据就绪后顶栏新增统计信息会压缩容器宽度，亦需重新对齐。仅操作自身 scrollLeft 而非 scrollIntoView，避免带动整个素材列表滚动
  useLayoutEffect(() => {
    const current = currentRef.current
    const list = current?.parentElement
    if (current === null || list == null) return
    const box = list.getBoundingClientRect()
    const item = current.getBoundingClientRect()
    if (item.left < box.left) list.scrollLeft -= box.left - item.left
    else if (item.right > box.right) list.scrollLeft += item.right - box.right
  }, [version.jobId, width])
  return (
    <div
      aria-label={`${take.label} 的版本`}
      className="wf-seg is-compact wf-take-versions"
      ref={listRef}
      role="group"
    >
      {take.versions.map((item) => {
        const current = item.jobId === version.jobId
        const inTrack = used.has(item.url)
        return (
          <TooltipRoot key={item.jobId}>
            <TooltipTrigger asChild>
              <button
                aria-label={inTrack ? `${item.version}，已入轨` : item.version}
                aria-pressed={current}
                className="wf-seg-item ui-state ui-focus"
                onClick={() => {
                  // 点击当前正在展示的版本不触发切换，避免误清空该原作下的镜头选区
                  if (!current) onVersion(take.id, item.jobId)
                }}
                ref={current ? currentRef : undefined}
                type="button"
              >
                {item.versionNumber}
                {inTrack && !current ? <i aria-hidden="true" className="wf-take-dot" /> : null}
              </button>
            </TooltipTrigger>
            <TooltipContent className="wf-tip" side="top">
              {inTrack ? `${item.version} · 已入轨` : item.version}
            </TooltipContent>
          </TooltipRoot>
        )
      })}
    </div>
  )
}
