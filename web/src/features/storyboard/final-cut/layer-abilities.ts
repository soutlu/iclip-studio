import { resolveEditingAffordances } from '@hyperframes/core/editing'

/**
 * 画布图层可编辑性判定：
 * 1. 基础能力复用引擎 `@hyperframes/core/editing` 的 `resolveEditingAffordances`（拦截锁定组件与合成根节点）；
 *    贴片与场景在画布上整体作为一层直接编辑主文件宿主（见 layer-edits.ts），因此不传 `isCompositionHost` 拦截；
 * 2. 额外拦截由 GSAP 动画脚本驱动的维度（对齐上游 Studio `editsPlainCss`，见 `gsapOwns`）：不反向修改脚本代码，脚本控制的属性禁止画布手改。
 * 预览页基于实时 DOM 与时间线实例完成判定，仅将布尔结果与拒绝码回传给编辑器。
 */

/** 拒绝画布编辑的原因码（按引擎判定优先级排列，`0` 表示允许）。 */
export const LayerRefusal = {
  none: 0,
  locked: 1,
  root: 2,
  animated: 3,
} as const
export type LayerRefusal = (typeof LayerRefusal)[keyof typeof LayerRefusal]

/** 画布几何编辑动作类型。 */
export type Gesture = 'move' | 'resize' | 'rotate'

/** 图层实时判定依据：是否为合成根节点（不含宿主）、是否位于锁定组件内，以及各维度是否受动画脚本驱动。 */
export type LayerFacts = {
  tag: string
  root: boolean
  locked: boolean
  animated: Readonly<Record<Gesture, boolean>>
}

export type LayerAbilities = Readonly<Record<Gesture, boolean>> & {
  /** 存在不可编辑维度时的首个拒绝原因（锁定 > 合成根 > 动画驱动）；全部可编辑时为 `none`。 */
  refusal: LayerRefusal
}

/** 根据图层实时事实判定移动、缩放、旋转三项能力及拒绝原因。 */
export function layerAbilities(facts: LayerFacts): LayerAbilities {
  const { capabilities } = resolveEditingAffordances({
    hasStableTarget: true,
    tag: facts.tag,
    inlineStyles: {},
    isCompositionHost: false,
    isCompositionRoot: facts.root,
    isInsideLockedComposition: facts.locked,
    isMasterView: false,
    existsInSource: true,
    hasEditableText: false,
    hasTimingStart: false,
    animationCount: 0,
  })
  const engine = {
    move: capabilities.canApplyManualOffset,
    resize: capabilities.canApplyManualSize,
    rotate: capabilities.canApplyManualRotation,
  }
  const engineRefusal: LayerRefusal = facts.locked
    ? LayerRefusal.locked
    : facts.root
      ? LayerRefusal.root
      : LayerRefusal.none
  const abilities = {
    move: engine.move && !facts.animated.move,
    resize: engine.resize && !facts.animated.resize,
    rotate: engine.rotate && !facts.animated.rotate,
  }
  const refused = !abilities.move || !abilities.resize || !abilities.rotate
  return {
    ...abilities,
    refusal:
      engineRefusal !== LayerRefusal.none
        ? engineRefusal
        : refused
          ? LayerRefusal.animated
          : LayerRefusal.none,
  }
}

/** 面向用户的画布不可编辑提示文案。 */
export const REFUSAL_TEXT: Record<Exclude<LayerRefusal, 0>, string> = {
  [LayerRefusal.locked]: '该片段已锁定，无法在画面上调整',
  [LayerRefusal.root]: '此元素为合成根，决定画面范围，无法在画面上调整',
  [LayerRefusal.animated]: '该片段的位置、大小或角度由动画脚本驱动，无法在画面上调整',
}

/** GSAP 运行时补间实例的最小读取接口：目标元素列表与驱动属性表。 */
export type RuntimeTween = {
  targets?: () => readonly unknown[]
  vars?: Readonly<Record<string, unknown>>
}

/** GSAP 运行时时间线实例（来自 `window.__timelines`）。 */
export type RuntimeTimeline = { getChildren?: (deep: boolean) => readonly RuntimeTween[] }

// GSAP 驱动位移、旋转与盒尺寸的属性集合（对齐上游 Studio `hooks/gsapRuntimeKeyframes.ts`）
const POSITION = ['x', 'y', 'xPercent', 'yPercent', 'left', 'top', 'translateX', 'translateY']
const MOVE = [...POSITION, 'motionPath']
const ROTATION = [
  ...['rotation', 'rotationX', 'rotationY', 'rotationZ'],
  ...['rotate', 'rotateX', 'rotateY', 'rotateZ'],
]
const BOX = [
  ...['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'],
  ...['flexBasis', 'flexGrow', 'flexShrink', 'boxSizing', 'scale', 'transformOrigin', 'display'],
  ...['scaleX', 'scaleY'],
]
const CHANNELS: Record<Gesture, readonly string[]> = {
  move: MOVE,
  resize: [...MOVE, ...BOX],
  rotate: ROTATION,
}

/** 检查补间 `vars`（含 `keyframes` 子步）是否写入了 `channels` 中的任意属性。 */
const writesAny = (vars: Readonly<Record<string, unknown>>, channels: readonly string[]) => {
  if (channels.some((channel) => channel in vars)) return true
  const keyframes = vars['keyframes']
  if (keyframes === null || typeof keyframes !== 'object') return false
  const steps: readonly unknown[] = Array.isArray(keyframes)
    ? keyframes
    : [keyframes, ...Object.values(keyframes)]
  return steps.some(
    (step) =>
      step !== null &&
      typeof step === 'object' &&
      channels.some((channel) => Object.hasOwn(step, channel)),
  )
}

/**
 * 判断运行时时间线 `timelines` 中是否存在补间（含零时长 `set`）控制 `element` 对应手势的属性。
 * 注意：仅检查活动补间，不检查元素上的 GSAP `renderTransform` 缓存——运行库应用手动位移时也会触发 GSAP 读取变换并留下该缓存，
 * 若将其计入会导致手动移动一次后即被误判为受动画驱动。
 */
export function gsapOwns(
  element: unknown,
  timelines: Readonly<Record<string, RuntimeTimeline>> | undefined,
  gesture: Gesture,
): boolean {
  return Object.values(timelines ?? {}).some((timeline) =>
    (timeline.getChildren?.(true) ?? []).some(
      (tween) =>
        tween.vars !== undefined &&
        (tween.targets?.() ?? []).includes(element) &&
        writesAny(tween.vars, CHANNELS[gesture]),
    ),
  )
}
