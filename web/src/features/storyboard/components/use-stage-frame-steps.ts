/** 舞台上切帧：点箭头与焦点在舞台里时按 ←/→ 走同一个 `stepFrame`。只接帧视图，成片舞台不接方向键。 */

import { useEffect, useEffectEvent } from 'react'

type FrameSteps = {
  /** 当前帧在当前段里排第几、这段共几帧；用来判断这一步会不会到头。 */
  position: { index: number; count: number } | undefined
  /** 上一帧、下一帧；到头的一侧不给。 */
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  /** 把焦点放回画面（「打开原图」按钮）。 */
  restFocus: () => void
}

/** 往前或往后切一帧；到头的一侧不动，返回是否切了。
 * 到头的那侧箭头随即消失：焦点正在它身上时交给画面，键盘用户不会掉回页面开头、↑↓ 切组也还收得到。 */
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

/** 这一下按键要往哪边切帧；不是 ←/→、别人已处理、正在输入法组词或带修饰键时为 undefined。 */
export const frameStepOfKey = (event: FrameKey): -1 | 1 | undefined => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return undefined
  if (event.defaultPrevented || event.isComposing) return undefined
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined
  return event.key === 'ArrowRight' ? 1 : -1
}

/** 在舞台元素上监听 ←/→：舞台本身不可聚焦，只收它里面获得焦点的控件（画面、箭头、帧计数）冒上来的按键；
 * 帧计数的弹层传送到了舞台外，打开时按键到不了这里。`onStep` 返回切了才吞掉按键；↑↓ 不碰，照旧冒到工作台根切组。 */
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
