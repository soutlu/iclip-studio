import { useLayoutEffect, useRef } from 'react'
import { useElementSize } from '@/shared/lib/use-element-size'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { Tool } from './editor-toolbar'
import type { Material, MaterialTake, UsedSpan } from './materials'

type TakeHeadProps = {
  take: MaterialTake
  /** 显示着的版本。 */
  version: Material
  /** 时间线上用掉的素材段，按素材地址分（见 `usedSpans`）：哪个版本入了轨按它看。 */
  used: ReadonlyMap<string, readonly UsedSpan[]>
  /** 镜头数和总长（毫秒），镜头读好了才有。 */
  shotCount: number | undefined
  durationMs: number | undefined
  /** 「+」还加不了时的原因。 */
  blocked: string | undefined
  onVersion: (takeId: string, jobId: string) => void
  onInsertWhole: () => void
}

/** 原作卡片的顶行：「出片 A」、版本、「● 已入轨」，右边镜头数、总长和整条加入轨道的「+」。 */
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

/** 两个及以上的版本：一排分段，点一下直接切；没在看的版本入了轨时带一个小绿点。 */
function TakeVersions({
  take,
  version,
  used,
  onVersion,
}: Pick<TakeHeadProps, 'take' | 'version' | 'used' | 'onVersion'>) {
  const [listRef, { width }] = useElementSize<HTMLDivElement>()
  const currentRef = useRef<HTMLButtonElement>(null)
  // 版本多到放不下时分段在自己的位置里横着滚：把选中的那段（默认是最新的，排在最右）滚进来。
  // 分段变窄时（镜头读好后顶行多出镜头数和总长）也要重新滚。只滚分段自己，不用 scrollIntoView，
  // 免得带着整个素材列表滚
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
      aria-label={`${take.label}的版本`}
      className="wf-seg wf-take-versions"
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
                  // 点正在看的那段不算换版本：换版本会收起这条原作上的选区
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
