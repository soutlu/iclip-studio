import { resolveEditingAffordances } from '@hyperframes/core/editing'

/**
 * 画面上一层能不能挪、缩放、转。先按引擎的能力判断（core `editing/affordances.ts` 的
 * `resolveEditingAffordances`：锁定的组件、脚本生成的、合成的根、宿主都不能改，里面的层能改），再拦掉动画脚本
 * 驱动的：我们不改动画脚本，脚本在动的那一样就不在画面上改（判断照工作台的 `editsPlainCss`，见 `gsapOwns`）。
 * 预览页按画面上的元素量出这些事实算好，回报给编辑器的只有结果。
 */

/** 不能改的原因，按引擎判断的先后；0 是能改。 */
export const LayerRefusal = {
  none: 0,
  locked: 1,
  generated: 2,
  root: 3,
  host: 4,
  animated: 5,
} as const
export type LayerRefusal = (typeof LayerRefusal)[keyof typeof LayerRefusal]

/** 画面上的三种改法。 */
export type Gesture = 'move' | 'resize' | 'rotate'

/** 一层的事实：是不是宿主、合成的根，在不在锁定的组件里，源文件里有没有它，动画脚本在动它的哪几样。 */
export type LayerFacts = {
  tag: string
  host: boolean
  root: boolean
  locked: boolean
  inSource: boolean
  animated: Readonly<Record<Gesture, boolean>>
}

export type LayerAbilities = Readonly<Record<Gesture, boolean>> & {
  /** 三样里有不能改的时第一个原因（按引擎判断的先后，动画最后），都能改时是 `none`。 */
  refusal: LayerRefusal
}

/** 按 `facts` 答这一层三样能不能改。 */
export function layerAbilities(facts: LayerFacts): LayerAbilities {
  const { capabilities } = resolveEditingAffordances({
    hasStableTarget: true,
    tag: facts.tag,
    inlineStyles: {},
    isCompositionHost: facts.host,
    isCompositionRoot: facts.root,
    isInsideLockedComposition: facts.locked,
    isMasterView: false,
    existsInSource: facts.inSource,
    hasEditableText: false,
    hasTimingStart: false,
    animationCount: 0,
  })
  const engine = {
    move: capabilities.canApplyManualOffset,
    resize: capabilities.canApplyManualSize,
    rotate: capabilities.canApplyManualRotation,
  }
  // 引擎拦下时的原因：照它判断的先后
  const engineRefusal: LayerRefusal = facts.locked
    ? LayerRefusal.locked
    : !facts.inSource
      ? LayerRefusal.generated
      : facts.root
        ? LayerRefusal.root
        : facts.host
          ? LayerRefusal.host
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

/** 给人看的原因。 */
export const REFUSAL_TEXT: Record<Exclude<LayerRefusal, 0>, string> = {
  [LayerRefusal.locked]: '这一层属于锁定的组件，不能在画面上调整',
  [LayerRefusal.generated]: '这一层由组件的脚本生成，不能在画面上调整',
  [LayerRefusal.root]: '这是合成的根，决定画面范围，不能在画面上调整',
  [LayerRefusal.host]: '请在画面上选中里面的层再调整',
  [LayerRefusal.animated]: '这一层的位置、大小或角度由动画脚本驱动，不能在画面上调整',
}

/** 动画库运行时的一段补间：它动哪些元素、写哪些属性。 */
export type RuntimeTween = {
  targets?: () => readonly unknown[]
  vars?: Readonly<Record<string, unknown>>
}

/** 动画库运行时的一条时间线（`window.__timelines` 里的）。 */
export type RuntimeTimeline = { getChildren?: (deep: boolean) => readonly RuntimeTween[] }

// 动画库写位置、角度、盒子用的属性名，照工作台 `hooks/gsapRuntimeKeyframes.ts`
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

/** 补间的属性（含关键帧里的）写不写 `channels` 里的哪一个。 */
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
 * 运行时各时间线 `timelines` 里有没有补间（含零时长的 `set`）在写 `element` 的这一样：位置（`move`），位置或盒子
 * （`resize`），角度（`rotate`）。照工作台的 `editsPlainCss` 判断，只看补间：工作台还把动画库已经接管了变换
 * （元素上缓存了 `renderTransform`）算进去，运行库摆放挪过的层时也会让动画库读一次变换、留下这个缓存，挪过一次
 * 就会被误当成动画在动它。
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
