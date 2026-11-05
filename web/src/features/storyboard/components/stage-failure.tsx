import { useId, useState } from 'react'
import { Icon } from '@/shared/icons'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'

type StageFailureProps = {
  title: string
  message: string | undefined
}

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
        {!message ? null : (
          <p className="stage-reason" hidden={!open} id={reasonId}>
            {message}
          </p>
        )}
      </div>
    </>
  )
}
