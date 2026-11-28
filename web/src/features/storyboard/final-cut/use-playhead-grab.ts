import { useRef, useState, type PointerEvent, type RefObject } from 'react'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import { clipIdAt, inLanes, togglesSelection } from './timeline-lanes'

// 各轨道行上距播放头竖线左右 6px 内按下即视作抓起播放头竖线
const PLAYHEAD_REACH = 6

/**
 * 在竖线上按下、还没拖开的这一下：没挪过 `DRAG_THRESHOLD` 就松手当作点了下面的东西（`clip` 是下面的片段，
 * 空白处是 null），挪过了才开始拖播放头（`started`）。
 */
type PlayheadPress = {
  pointerId: number
  originX: number
  originY: number
  clip: string | null
  started: boolean
}

/**
 * 在各行上按住播放头的竖线拖动定位：按下先不给下面的片段、框选，拖开了才拖播放头（`scrubTo`，松手 `endScrub`），
 * 没拖开就松手当作点了下面的东西（片段照 `pick` 选中，空白处 `onSelect` 取消选中）。`overPlayhead` 是指针停在竖线上
 * （光标画成左右拖的样子），`scrubbing` 是正拖着播放头。返回这两个状态和挂在各行上的处理函数；`dragPlayhead`、
 * `releasePlayhead`、`cancelPlayhead` 答 true 时这一下归播放头，别的处理不再管它。
 */
export function usePlayheadGrab({
  razor,
  totalMs,
  selected,
  rulerBarRef,
  gesturing,
  timeAt,
  scrubTo,
  endScrub,
  onSelect,
  pick,
}: {
  /** 切开工具下竖线不能拖，点击归剃刀。 */
  razor: boolean
  totalMs: number
  selected: ReadonlySet<string>
  /** 时间尺那一条，播放头竖线画在它里面。 */
  rulerBarRef: RefObject<HTMLDivElement | null>
  /** 正在拖片段、框选：这时指针停在竖线上也不换光标。 */
  gesturing: boolean
  timeAt: (clientX: number) => number
  scrubTo: (ms: number) => void
  endScrub: () => void
  onSelect: (ids: ReadonlySet<string>) => void
  pick: (id: string, toggle: boolean, clicked: boolean) => void
}) {
  /**
   * 各行上按左键是不是按在了播放头的竖线上：离画出来的竖线不到 `PLAYHEAD_REACH` 像素，而且不是按在选中的片段上。
   * 选中的片段整个优先（身体、把手、音量曲线都算；把手只画在选中的片段上，曲线也只在选中时能改）：点选后播放头
   * 常常跳到指针下面，再按照样是拖这个片段、双击它。竖线还没排版（量不到高度）时不算；切开工具下竖线不能拖，点击
   * 归剃刀；final-cut 是空的时也不能拖。竖线本身不接收指针，按位置在这里判断，所以右键照常落到下面的片段或空档上。
   */
  const onPlayheadLine = (event: { clientX: number; target: EventTarget }) => {
    if (razor || totalMs <= 0) return false
    const under = clipIdAt(event.target)
    if (under !== undefined && selected.has(under)) return false
    const line = rulerBarRef.current?.querySelector('.timeline-playhead')?.getBoundingClientRect()
    return (
      line !== undefined &&
      line.height > 0 &&
      Math.abs(event.clientX - (line.left + line.width / 2)) <= PLAYHEAD_REACH
    )
  }

  // 按住播放头的竖线拖动定位；指针停在竖线上（不在选中的片段上）时光标是左右拖的样子
  const playheadPressRef = useRef<PlayheadPress | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [overPlayhead, setOverPlayhead] = useState(false)
  const pressPlayhead = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !inLanes(event) || !onPlayheadLine(event)) return
    // 按在竖线上先不给下面的片段、框选，拖开了才拖播放头，没拖开就松手当作点了下面的东西
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    playheadPressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      clip: clipIdAt(event.target) ?? null,
      started: false,
    }
  }
  /** 按着竖线挪：挪过阈值才开始拖播放头，之后跟着指针定位。答 true（这一下用掉了）。 */
  const dragPlayhead = (event: PointerEvent<HTMLDivElement>) => {
    const press = playheadPressRef.current
    if (press === null || press.pointerId !== event.pointerId) return false
    if (!press.started) {
      const moved = Math.hypot(event.clientX - press.originX, event.clientY - press.originY)
      if (moved <= DRAG_THRESHOLD) return true
      press.started = true
      setScrubbing(true)
    }
    scrubTo(timeAt(event.clientX))
    return true
  }
  /**
   * 松开按着竖线的这一下：拖过的收起；没拖开的当作点了下面的东西，片段照点选的规则选中（Shift、⌘、Ctrl 照常是
   * 加减选中），空白处照点空白处取消选中。答 true（这一下用掉了）。
   */
  const releasePlayhead = (event: PointerEvent<HTMLDivElement>) => {
    const press = playheadPressRef.current
    if (press === null || press.pointerId !== event.pointerId) return false
    playheadPressRef.current = null
    releasePointer(event)
    if (press.started) {
      setScrubbing(false)
      endScrub()
    } else if (press.clip === null) onSelect(new Set())
    else pick(press.clip, togglesSelection(event), true)
    return true
  }
  /** 按着竖线的这一下被取消：拖过的收起，没拖开的什么都不做。答 true（这一下用掉了）。 */
  const cancelPlayhead = (event: PointerEvent<HTMLDivElement>) => {
    const press = playheadPressRef.current
    if (press === null || press.pointerId !== event.pointerId) return false
    playheadPressRef.current = null
    if (press.started) {
      setScrubbing(false)
      endScrub()
    }
    return true
  }
  const hoverPlayhead = (event: PointerEvent<HTMLDivElement>) =>
    setOverPlayhead(
      !gesturing && event.pointerType !== 'touch' && inLanes(event) && onPlayheadLine(event),
    )

  return {
    scrubbing,
    overPlayhead,
    setOverPlayhead,
    pressPlayhead,
    dragPlayhead,
    releasePlayhead,
    cancelPlayhead,
    hoverPlayhead,
  }
}
