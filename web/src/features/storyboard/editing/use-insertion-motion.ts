import { useEffect, useState } from 'react'

const poseKeys = ['x', 'y', 'width', 'height', 'opacity', 'scale'] as const
type Pose = Partial<Record<(typeof poseKeys)[number], number>>

export type MotionSnapshot = {
  value: Pose
  velocity: Pose
}

type MotionState = MotionSnapshot & {
  node: HTMLElement
  target: Pose
  time: number
  onRest: (() => void) | undefined
}

type MoveOptions = {
  immediate?: boolean
  onRest?: () => void
}

function paint(state: MotionState) {
  const { node, value } = state
  if (value.x !== undefined || value.y !== undefined || value.scale !== undefined) {
    node.style.transform = `translate3d(${value.x ?? 0}px, ${value.y ?? 0}px, 0) scale(${value.scale ?? 1})`
  }
  if (value.width !== undefined) node.style.width = `${Math.max(1, value.width)}px`
  if (value.height !== undefined) node.style.height = `${Math.max(1, value.height)}px`
  if (value.opacity !== undefined) {
    node.style.opacity = String(Math.max(0, Math.min(1, value.opacity)))
  }
}

function advance(state: MotionState, now: number, immediate: boolean) {
  const dt = Math.min(0.064, Math.max(0, (now - state.time) / 1000))
  state.time = now
  let settled = true
  for (const key of poseKeys) {
    const target = state.target[key]
    if (target === undefined) continue
    const value = state.value[key] ?? target
    const velocity = state.velocity[key] ?? 0
    const small = key === 'opacity' || key === 'scale'
    const omega = small ? 32 : 26
    const displacement = value - target
    const coefficient = velocity + omega * displacement
    const decay = Math.exp(-omega * dt)
    const nextValue = target + (displacement + coefficient * dt) * decay
    const nextVelocity = (velocity - omega * coefficient * dt) * decay
    if (
      immediate ||
      (Math.abs(nextValue - target) < (small ? 0.002 : 0.08) &&
        Math.abs(nextVelocity) < (small ? 0.04 : 1))
    ) {
      state.value[key] = target
      state.velocity[key] = 0
    } else {
      state.value[key] = nextValue
      state.velocity[key] = nextVelocity
      settled = false
    }
  }
  return settled
}

function createMotionDriver() {
  let states = new WeakMap<HTMLElement, MotionState>()
  const moving = new Set<MotionState>()
  let frame = 0
  let preference: MediaQueryList | undefined

  const reducedMotion = () => {
    preference ??= window.matchMedia('(prefers-reduced-motion: reduce)')
    return preference.matches
  }

  const finish = (state: MotionState) => {
    moving.delete(state)
    if (moving.size === 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    const onRest = state.onRest
    state.onRest = undefined
    onRest?.()
  }

  const tick = (now: number) => {
    frame = 0
    const reduced = reducedMotion()
    for (const state of [...moving]) {
      if (!moving.has(state)) continue
      if (!state.node.isConnected) {
        moving.delete(state)
        states.delete(state.node)
        continue
      }
      const settled = advance(state, now, reduced)
      paint(state)
      if (settled) finish(state)
    }
    if (moving.size > 0 && frame === 0) frame = requestAnimationFrame(tick)
  }

  const seed = (node: HTMLElement, snapshot: MotionSnapshot) => {
    const previous = states.get(node)
    if (previous !== undefined) moving.delete(previous)
    if (moving.size === 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    const state: MotionState = {
      node,
      value: { ...snapshot.value },
      velocity: { ...snapshot.velocity },
      target: { ...snapshot.value },
      time: performance.now(),
      onRest: undefined,
    }
    states.set(node, state)
    paint(state)
    return state
  }

  return {
    move(node: HTMLElement, target: Pose, options: MoveOptions = {}) {
      const reduced = reducedMotion()
      const now = performance.now()
      const state = states.get(node) ?? seed(node, { value: target, velocity: {} })
      advance(state, now, reduced)
      state.onRest = options.onRest
      for (const key of poseKeys) {
        const value = target[key]
        if (value === undefined) continue
        state.target[key] = value
        // 跟手坐标立即更新，其它字段仍可继续入场或收束。
        if (options.immediate === true || reduced || state.value[key] === undefined) {
          state.value[key] = value
          state.velocity[key] = 0
        }
      }
      const settled = advance(state, now, reduced)
      paint(state)
      if (settled) {
        finish(state)
      } else {
        moving.add(state)
        if (frame === 0) frame = requestAnimationFrame(tick)
      }
    },
    read(node: HTMLElement): MotionSnapshot | undefined {
      const state = states.get(node)
      if (state === undefined) return undefined
      return { value: { ...state.value }, velocity: { ...state.velocity } }
    },
    seed(node: HTMLElement, snapshot: MotionSnapshot) {
      seed(node, snapshot)
    },
    dispose() {
      cancelAnimationFrame(frame)
      frame = 0
      moving.clear()
      states = new WeakMap()
      preference = undefined
    },
  }
}

/** 插入预演与落位共用连续的临界阻尼运动；目标变化时保留当前位置和速度。 */
export function useInsertionMotion() {
  const [motion] = useState(createMotionDriver)
  useEffect(() => () => motion.dispose(), [motion])
  return motion
}
