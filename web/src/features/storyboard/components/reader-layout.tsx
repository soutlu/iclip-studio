import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'

type ReaderLayoutProps = {
  group: number
  stage: ReactNode
  toolbar: ReactNode
  script: ReactNode
  takes: ReactNode
}

/**
 * 分镜页与制作页共用的一组版面：左边舞台，右边浮起的脚本面板（头部是工具行，底部是素材片区）。
 * 版面和工具行跨组常驻，换组后组号切换器上的焦点还在；舞台、脚本与素材片区按组号重挂，组内状态随组重置。
 * 上下排时整个版面自己竖向滚，换组回到顶部。
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
