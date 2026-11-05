import { useEffect, useEffectEvent } from 'react'

type FrameSteps = {
  position: { index: number; count: number } | undefined
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  restFocus: () => void
}

export const stepFrame = (
  { onNext, onPrevious, position, restFocus }: FrameSteps,
  step: -1 | 1,
): boolean => {
  const move = step === 1 ? onNext : onPrevious
  if (move === undefined) return false
  const focused = document.activeElement
  const leaving =
    focused instanceof HTMLElement && focused.dataset['side'] === (step === 1 ? 'next' : 'previous')
  move()
  const reachesEnd =
    position !== undefined &&
    (step === 1 ? position.index + 1 === position.count : position.index - 1 === 1)
  if (leaving && reachesEnd) restFocus()
  return true
}

type FrameKey = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'
>

export const frameStepOfKey = (event: FrameKey): -1 | 1 | undefined => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return undefined
  if (event.defaultPrevented || event.isComposing) return undefined
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined
  return event.key === 'ArrowRight' ? 1 : -1
}

export const useStageFrameKeys = (stage: HTMLElement | null, onStep: (step: -1 | 1) => boolean) => {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    const step = frameStepOfKey(event)
    if (step !== undefined && onStep(step)) event.preventDefault()
  })
  useEffect(() => {
    if (stage === null) return
    const onKeyDown = (event: KeyboardEvent) => handle(event)
    stage.addEventListener('keydown', onKeyDown)
    return () => stage.removeEventListener('keydown', onKeyDown)
  }, [stage])
}
