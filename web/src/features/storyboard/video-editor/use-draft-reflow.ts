import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { DraftItem } from './draft'

/** 一块在轨道区里的横向位置（像素，从轨道区左边量），含正在进行的动画。 */
export type Span = { left: number; width: number }

/**
 * 开关后自动出现的那一对关联：`id` 是草稿块的 id（编辑段与编辑轨上那一段、原片镜头与原片轨上那个镜头同 id）。
 * `out` 是拿掉的那一块（连到它收起的位置，随收起一起淡出），`fading` 是停留之后开始淡出。
 */
export type Flash = { id: string; kind: DraftItem['kind']; out: boolean; fading: boolean }

/** 开关后连线停留多久再淡出。 */
const LINK_HOLD_MS = 1000
/** 等平滑滚动停下最多等多久：浏览器不发 scrollend 时不卡住动画。 */
const SCROLL_WAIT_MS = 700
/** 滚到新块时两边留的空。 */
const SCROLL_MARGIN_PX = 24

const after = (ms: number, run: () => void) => window.setTimeout(run, ms)

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const idsOf = (items: readonly DraftItem[]) => items.map((item) => item.id).join(' ')

/** 草稿里加了或拿掉了哪一块：编辑段优先（选用一段会同时关掉它覆盖的镜头），加的优先于拿掉的。 */
const flashOf = (before: readonly DraftItem[], after: readonly DraftItem[]): Flash | undefined => {
  const added = after.filter((item) => !before.some((other) => other.id === item.id))
  const removed = before.filter((item) => !after.some((other) => other.id === item.id))
  const candidates = [
    ...added.map((item) => ({ item, out: false })),
    ...removed.map((item) => ({ item, out: true })),
  ]
  const chosen = candidates.find(({ item }) => item.kind === 'edit') ?? candidates[0]
  return chosen === undefined
    ? undefined
    : { id: chosen.item.id, kind: chosen.item.kind, out: chosen.out, fading: false }
}

/** 草稿轨上每块此刻的位置（`data-draft-id`），与此刻每秒多少像素。 */
const measure = (lanes: HTMLElement, content: number) => {
  const box = lanes.getBoundingClientRect()
  const spans = new Map<string, Span>()
  for (const node of lanes.querySelectorAll<HTMLElement>('[data-draft-id]')) {
    const rect = node.getBoundingClientRect()
    spans.set(node.dataset['draftId'] ?? '', { left: rect.left - box.left, width: rect.width })
  }
  return { spans, pps: content > 0 ? box.width / content : 0 }
}

const nodesOf = (lanes: HTMLElement, attribute: string, id: string) =>
  [...lanes.querySelectorAll<HTMLElement>(`[${attribute}]`)].filter(
    (node) => node.getAttribute(attribute) === id,
  )

/** 等元素的平滑滚动停下。 */
const scrolled = (element: HTMLElement) =>
  new Promise<void>((done) => {
    const timer = window.setTimeout(done, SCROLL_WAIT_MS)
    element.addEventListener(
      'scrollend',
      () => {
        window.clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })

type Options = {
  lanesRef: RefObject<HTMLElement | null>
  scrollRef: RefObject<HTMLElement | null>
  /** 草稿轨此刻画的块：拖放预演时是给落点让位后的样子。 */
  shown: readonly DraftItem[]
  /** 草稿本身：只有它的块变了才算开关，才出连线。 */
  committed: readonly DraftItem[]
  /** 拖放预演的落点；没有预演时为空串。 */
  previewKey: string
  /** 轨道区要铺的秒数（不算收起期间保持的宽）。 */
  content: number
  /** 正在拖修剪把手：草稿怎么变都不做动画。 */
  frozen: boolean
  /** 重排动画进行中每帧调一次（重画连线）。 */
  onFrame: () => void
}

/**
 * 草稿的块变了之后（点眼睛、点编辑段、拖进拖出、Delete，或拖放预演换了落点），把草稿轨上的块从原来的位置
 * 平移到新位置，新加入的从宽 0 展开，拿掉的在原地收起；原片轨、编辑轨、标尺不动。草稿变短时收起期间轨道区
 * 保持原来的宽，结束后再收回（先平滑滚回）。新加入的块在可视范围外时先平滑滚过去再动画。时长与缓动取设计
 * 系统的 `--dur-m`、`--ease`；系统要求减少动态效果时直接显示结果。
 *
 * 返回正在收起的块（画在原位、不能点）、收起期间保持的宽、开关后自动出现的那一对关联，以及：
 * `land` 拖放松手前交出落点占位的位置，新块从那里落位；`cancel` 停下动画与连线，直接显示结果（开始修剪时）。
 */
export function useDraftReflow({
  lanesRef,
  scrollRef,
  shown,
  committed,
  previewKey,
  content,
  frozen,
  onFrame,
}: Options) {
  const shownKey = `${idsOf(shown)}|${previewKey}`
  const committedKey = idsOf(committed)
  const layoutKey = `${shown.map((item) => `${item.id}:${item.at}:${item.d}`).join(' ')}|${content}`
  const [last, setLast] = useState({ shownKey, committedKey, layoutKey, shown, committed, content })
  const [leaving, setLeaving] = useState<readonly DraftItem[]>([])
  const [hold, setHold] = useState<number>()
  const [flash, setFlash] = useState<Flash>()
  const [run, setRun] = useState(0)
  const spansRef = useRef<ReturnType<typeof measure>>(undefined)
  const landingRef = useRef<{ id: string; span: Span }>(undefined)
  const stopRef = useRef<(() => void) | undefined>(undefined)
  // 动画进行中：各块的位置由每一帧记，不在画完时记。
  const animatingRef = useRef(false)

  // 记着上一次画的草稿，变了就在这一次渲染里定下要收起的块、要保持的宽和要连的那一对，effect 里再动画。
  if (
    shownKey !== last.shownKey ||
    committedKey !== last.committedKey ||
    layoutKey !== last.layoutKey
  ) {
    const changed = shownKey !== last.shownKey || committedKey !== last.committedKey
    if (changed && !frozen) {
      const reduce = reducedMotion()
      setLeaving(reduce ? [] : last.shown.filter((item) => !shown.some((o) => o.id === item.id)))
      // 草稿变短：收起期间不比变之前窄，免得滚到最右时内容变短、整条时间线在指针下跳。
      const wide = Math.max(last.content, hold ?? 0)
      setHold(!reduce && wide > content ? wide : undefined)
      if (committedKey !== last.committedKey) setFlash(flashOf(last.committed, committed))
      setRun(run + 1)
    }
    setLast({ shownKey, committedKey, layoutKey, shown, committed, content })
  }

  const frame = useEffectEvent(onFrame)

  /** 连线停留 LINK_HOLD_MS 后淡出，淡完拿掉；计时器记进 `timers`，停下时一起清掉。 */
  const fadeLater = (shownFlash: Flash, fadeMs: number, timers: number[]) => {
    const faded = { ...shownFlash, fading: true }
    timers.push(
      after(LINK_HOLD_MS, () => {
        setFlash((current) => (current === shownFlash ? faded : current))
        timers.push(
          after(fadeMs, () => setFlash((current) => (current === faded ? undefined : current))),
        )
      }),
    )
  }

  const start = useEffectEvent(() => {
    const lanes = lanesRef.current
    const scroller = scrollRef.current
    if (lanes === null || scroller === null) return undefined
    const before = spansRef.current
    // 轨道区此刻铺的秒数（含收起期间保持的宽）
    const seconds = Math.max(content, hold ?? 0)
    const now = measure(lanes, seconds)
    const landing = landingRef.current
    landingRef.current = undefined
    const reduce = reducedMotion()
    const style = getComputedStyle(lanes)
    const timing = {
      duration: Number.parseFloat(style.getPropertyValue('--dur-m')),
      easing: style.getPropertyValue('--ease').trim(),
    }
    const fadeMs = Number.parseFloat(style.getPropertyValue('--dur-s'))
    const animations: Animation[] = []
    let frameId = 0
    const timers: number[] = []
    let live = true

    // 每秒像素没变才动画（可视宽变了时直接是结果）；轨道区宽按亚像素取整，整条轨道上差不到 1px 算没变
    if (!reduce && before !== undefined && Math.abs(before.pps - now.pps) * seconds < 1) {
      for (const [id, span] of now.spans) {
        const landed = landing?.id === id ? landing.span : undefined
        const was = landed ?? before.spans.get(id)
        const [node] = nodesOf(lanes, 'data-draft-id', id)
        if (node === undefined) continue
        if (was === undefined) {
          animations.push(node.animate([{ width: '0px' }, { width: `${span.width}px` }], timing))
          continue
        }
        const dx = was.left - span.left
        if (Math.abs(dx) < 0.5 && Math.abs(was.width - span.width) < 0.5 && landed === undefined)
          continue
        const from = { transform: `translateX(${dx}px)`, width: `${was.width}px` }
        const to = { transform: 'none', width: `${span.width}px` }
        animations.push(
          node.animate(
            landed === undefined
              ? [from, to]
              : [
                  { ...from, opacity: 0.65 },
                  { ...to, opacity: 1 },
                ],
            timing,
          ),
        )
        // 选中描边、修剪把手跟着它那块走。
        for (const follower of nodesOf(lanes, 'data-follows', id))
          animations.push(follower.animate([from, to], timing))
      }
      for (const node of lanes.querySelectorAll<HTMLElement>('[data-leaving-id]')) {
        const was = before.spans.get(node.dataset['leavingId'] ?? '')
        if (was === undefined) continue
        node.style.left = `${was.left}px`
        node.style.width = `${was.width}px`
        animations.push(
          node.animate([{ width: `${was.width}px` }, { width: '0px' }], {
            ...timing,
            fill: 'forwards',
          }),
        )
      }
    }

    const follow = () => {
      if (!live) return
      spansRef.current = measure(lanes, seconds)
      frame()
      frameId = requestAnimationFrame(follow)
    }

    /** 动画都结束后：收回保持的宽（滚动位置超出新宽时先平滑滚回来），连线停留后淡出。 */
    const settle = async () => {
      cancelAnimationFrame(frameId)
      if (!live) return
      animatingRef.current = false
      spansRef.current = measure(lanes, seconds)
      setLeaving([])
      frame()
      if (hold !== undefined) {
        const lanesWidth = lanes.getBoundingClientRect().width
        const max = Math.max(
          0,
          scroller.scrollWidth - lanesWidth + content * now.pps - scroller.clientWidth,
        )
        if (scroller.scrollLeft > max + 0.5) {
          if (reduce) scroller.scrollLeft = max
          else {
            scroller.scrollTo({ left: max, behavior: 'smooth' })
            await scrolled(scroller)
          }
        }
        if (!live) return
        setHold(undefined)
      }
      if (flash === undefined) return
      if (flash.out) {
        setFlash(undefined)
        return
      }
      fadeLater(flash, Number.isFinite(fadeMs) ? fadeMs : 0, timers)
    }

    const play = (paused: boolean) => {
      if (!live) return
      if (paused) for (const animation of animations) animation.play()
      frameId = requestAnimationFrame(follow)
      void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(
        settle,
      )
    }

    // 新加入的块不在可视范围内：先滚到能看见它（比可视宽还宽时对齐它的开头），再动画。
    const added = flash !== undefined && !flash.out ? now.spans.get(flash.id) : undefined
    const view = scroller.getBoundingClientRect()
    const origin = lanes.getBoundingClientRect().left
    let target: number | undefined
    if (added !== undefined && scroller.clientWidth > 0) {
      const left = origin + added.left
      const right = left + added.width
      if (left < view.left || right > view.right) {
        const delta =
          added.width + 2 * SCROLL_MARGIN_PX > view.width || left < view.left
            ? left - view.left - SCROLL_MARGIN_PX
            : right + SCROLL_MARGIN_PX - view.right
        target = Math.max(
          0,
          Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + delta),
        )
      }
    }
    if (target === undefined || Math.abs(target - scroller.scrollLeft) < 1) play(false)
    else if (reduce) {
      scroller.scrollLeft = target
      play(false)
    } else {
      for (const animation of animations) animation.pause()
      scroller.scrollTo({ left: target, behavior: 'smooth' })
      void scrolled(scroller).then(() => play(true))
    }

    const stop = () => {
      live = false
      animatingRef.current = false
      cancelAnimationFrame(frameId)
      for (const timer of timers) window.clearTimeout(timer)
      for (const animation of animations) animation.cancel()
    }
    animatingRef.current = true
    stopRef.current = stop
    return stop
  })

  useLayoutEffect(() => (run === 0 ? undefined : start()), [run])

  // 没在动画时，每次画完记下各块的位置，作为下一次开关前的位置。
  useLayoutEffect(() => {
    const lanes = lanesRef.current
    if (lanes === null || animatingRef.current) return
    spansRef.current = measure(lanes, Math.max(content, hold ?? 0))
  })

  return {
    leaving,
    hold,
    flash,
    /** 拖放松手、草稿还没变之前：新块从落点占位的位置（像素，从轨道区左边量）落下来。 */
    land: (id: string, span: Span) => {
      landingRef.current = { id, span }
    },
    /** 停下动画与连线，直接显示结果。 */
    cancel: () => {
      stopRef.current?.()
      stopRef.current = undefined
      setLeaving([])
      setHold(undefined)
      setFlash(undefined)
    },
  }
}
