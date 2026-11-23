import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'

type ReaderLayoutProps = {
  group: number
  stage: ReactNode
  toolbar: ReactNode
  script: ReactNode
  takes: ReactNode
}

/**
 * 分镜页与制作页共用的布局容器：左侧为舞台，右侧为浮起脚本面板（顶部工具行、底部素材片区）。
 * 容器与工具行跨镜头组常驻，切换镜头组时保留组号切换器焦点；舞台、脚本与素材片区按组号重挂以重置组内状态。
 * 窄宽上下排列时整体纵向滚动，切换镜头组后自动回顶。
 */
export function ReaderLayout({ group, script, stage, takes, toolbar }: ReaderLayoutProps) {
  const ref = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (ref.current !== null) ref.current.scrollTop = 0
  }, [group])
  return (
    <section aria-label={`镜头组 ${group}`} className="storyboard-body" ref={ref} tabIndex={-1}>
      <Fragment key={group}>{stage}</Fragment>
      <div className="storyboard-script">
        {toolbar}
        <Fragment key={group}>
          {script}
          {takes}
        </Fragment>
      </div>
    </section>
  )
}
