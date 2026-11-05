import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { DraftItem } from './draft'

export type Span = { left: number; width: number }

export type Flash = { id: string; kind: DraftItem['kind']; out: boolean; fading: boolean }

const LINK_HOLD_MS = 1000
const SCROLL_WAIT_MS = 700
const SCROLL_MARGIN_PX = 24

const after = (ms: number, run: () => void) => window.setTimeout(run, ms)

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const idsOf = (items: readonly DraftItem[]) => items.map((item) => item.id).join(' ')

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
  shown: readonly DraftItem[]
  committed: readonly DraftItem[]
  previewKey: string
  content: number
  frozen: boolean
  onFrame: () => void
}

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
  const animatingRef = useRef(false)

  if (
    shownKey !== last.shownKey ||
    committedKey !== last.committedKey ||
    layoutKey !== last.layoutKey
  ) {
    const changed = shownKey !== last.shownKey || committedKey !== last.committedKey
    if (changed && !frozen) {
      const reduce = reducedMotion()
      setLeaving(reduce ? [] : last.shown.filter((item) => !shown.some((o) => o.id === item.id)))
      const wide = Math.max(last.content, hold ?? 0)
      setHold(!reduce && wide > content ? wide : undefined)
      if (committedKey !== last.committedKey) setFlash(flashOf(last.committed, committed))
      setRun(run + 1)
    }
    setLast({ shownKey, committedKey, layoutKey, shown, committed, content })
  }

  const frame = useEffectEvent(onFrame)

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

  useLayoutEffect(() => {
    const lanes = lanesRef.current
    if (lanes === null || animatingRef.current) return
    spansRef.current = measure(lanes, Math.max(content, hold ?? 0))
  })

  return {
    leaving,
    hold,
    flash,
    land: (id: string, span: Span) => {
      landingRef.current = { id, span }
    },
    cancel: () => {
      stopRef.current?.()
      stopRef.current = undefined
      setLeaving([])
      setHold(undefined)
      setFlash(undefined)
    },
  }
}
