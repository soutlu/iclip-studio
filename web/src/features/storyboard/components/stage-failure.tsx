import { useId, useState } from 'react'
import { Icon } from '@/shared/icons'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'

type StageFailureProps = {
  /** 胶囊上的字，如「生成失败」「合成失败」。 */
  title: string
  /** 任务的失败原因；为空时只显示失败胶囊。 */
  message: string | undefined
}

/**
 * 编辑器舞台上的失败状态：压暗画面，正中一个失败胶囊，有原因时旁边「查看原因」，点开就地展开，Esc 收起。
 * 铺满最近的定位祖先；换一条任务时按任务给 key，展开状态随之重置。
 */
export function StageFailure({ title, message }: StageFailureProps) {
  const [open, setOpen] = useState(false)
  const reasonId = useId()
  useEscapeAheadOfDialog(open, () => setOpen(false))
  return (
    <>
      <span aria-hidden="true" className="stage-dim" data-failed="" />
      <div className="stage-status">
        <div className="stage-status-row">
          <span className="stage-pill" role="alert">
            <Icon className="text-error" decorative name="alert" size="sm" />
            {title}
          </span>
          {!message ? null : (
            <button
              aria-controls={reasonId}
              aria-expanded={open}
              className="stage-pill stage-pill-button ui-focus"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              查看原因
              <Icon decorative name="expand" size="sm" />
            </button>
          )}
        </div>
        {/* 原文常是服务端的长响应，只在用户要看时铺开。 */}
        {!message ? null : (
          <p className="stage-reason" hidden={!open} id={reasonId}>
            {message}
          </p>
        )}
      </div>
    </>
  )
}
