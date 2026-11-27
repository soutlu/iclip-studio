import { buildStableSelector, resolveLayerSelector } from '@hyperframes/core/runtime/editing-port'

/**
 * 画布可编辑图层表：根据工程文件当前内容生成，供编辑器与预览页按统一索引寻址。
 * 为隔离不可信工程脚本，预览页仅回传图层表下标；每项由编辑器定义为「所属宿主 + 稳定选择器 + 同名序号」，预览页据此定位 DOM 元素。
 *
 * 选择器生成复用运行库 `buildStableSelector`（按 `id`、`data-composition-id`、`data-hf-group`、`class` 优先级提取）；
 * 排除非可视标签，以及除组件宿主外被 `resolveLayerSelector` 过滤的合成根节点。同名匹配序号按源码出现顺序编号。
 */

/** 非可视元素标签（对齐运行库 `isInspectableLayerElement` 跳过列表，并额外排除 `<audio>`）。 */
const IGNORED_TAGS = new Set([
  'audio',
  'base',
  'br',
  'canvas',
  'link',
  'meta',
  'script',
  'source',
  'style',
  'template',
  'track',
  'wbr',
])

/** 源文件中的目标元素：SDK 标识（`data-hf-id`，写回文件时据此定位）及当前非行内样式属性。 */
export type SourceElement = {
  hfId: string
  tag: string
  /** 除 `style` 以外的 HTML 属性快照。 */
  attributes: Readonly<Record<string, string>>
}

/**
 * 画布上的可编辑图层或元素/模板宿主（`host: true`，元素与模板片段在画布上整体作为一层编辑，内部子元素不入表）：
 * - `scope`：所属宿主的 `data-hf-id`（主文件顶层元素为 `null`）。
 * - `selector`、`index`：在该作用域内匹配选择器的序号；`count` 为源文件中的总匹配数（若预览 DOM 因脚本动态增删导致数量不一致，则拒绝匹配）。
 * - `file`：所属工程文件相对路径；`clip`：归属的时间线片段 ID（宿主、单句字幕或视频片段）。
 * - `locked`：自身或源文件祖先带有 `data-timeline-locked`。
 */
export type CanvasLayer = {
  key: string
  scope: string | null
  selector: string
  index: number
  count: number
  file: string
  clip: string
  host: boolean
  locked: boolean
  element: SourceElement
}

const sourceElementOf = (element: Element): SourceElement | undefined => {
  const hfId = element.getAttribute('data-hf-id')
  if (hfId === null) return undefined
  return {
    hfId,
    tag: element.localName,
    attributes: Object.fromEntries(
      [...element.attributes]
        .filter((attribute) => attribute.name !== 'style')
        .map((attribute) => [attribute.name, attribute.value]),
    ),
  }
}

/** 提取 HTML 文件的实际挂载根节点：存在 `<template>` 时取首个模板内容（与运行库挂载规则一致），否则取 `<body>`。 */
function mountedPart(html: string): ParentNode {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const template = page.querySelector('template')
  return template === null ? page.body : template.content
}

/**
 * 收集单个文件节点下的可编辑图层：`clipOf` 根据合成根下的直接子元素（`top`）解析归属片段 ID（返回 `undefined` 则跳过）；
 * 命中 `hosts` 集合（按 `data-hf-id`）的组件宿主一并收入并标记 `host: true`。
 */
function layersIn(
  part: ParentNode,
  file: string,
  scope: string | null,
  clipOf: (top: Element) => string | undefined,
  hosts: ReadonlySet<string> = new Set(),
): CanvasLayer[] {
  const found: { element: Element; top: Element; locked: boolean }[] = []
  const visit = (node: ParentNode, top: Element | null, locked: boolean) => {
    for (const child of node.children) {
      const lockedHere = locked || child.hasAttribute('data-timeline-locked')
      found.push({ element: child, top: top ?? child, locked: lockedHere })
      // 合成根下的每个直接子元素各自对应一个片段
      const next = child.hasAttribute('data-composition-id') ? null : (top ?? child)
      visit(child, next, lockedHere)
    }
  }
  visit(part, null, false)
  const counts = new Map<string, number>()
  const indexed = found.map(
    (entry): (typeof found)[number] & { selector?: string; index: number } => {
      const selector = buildStableSelector(entry.element)
      if (selector === undefined) return { ...entry, index: -1 }
      const index = counts.get(selector) ?? 0
      counts.set(selector, index + 1)
      return { ...entry, selector, index }
    },
  )
  return indexed.flatMap((entry) => {
    const clip = clipOf(entry.top)
    const element = sourceElementOf(entry.element)
    const { selector, index, locked } = entry
    const host = element !== undefined && hosts.has(element.hfId)
    if (
      selector === undefined ||
      clip === undefined ||
      element === undefined ||
      IGNORED_TAGS.has(element.tag) ||
      (!host && resolveLayerSelector(entry.element as HTMLElement) === undefined)
    )
      return []
    return [
      {
        key: layerKey(scope, selector, index),
        scope,
        selector,
        index,
        count: counts.get(selector) ?? 0,
        file,
        clip,
        host,
        locked,
        element,
      },
    ]
  })
}

/** 拼接图层唯一键：`scope`、`selector` 与 `index` 以换行符连接（选择器不含换行）。 */
export const layerKey = (scope: string | null, selector: string, index: number): string =>
  `${scope ?? ''}\n${selector}\n${index}`

/** 主文件根下的外部挂载宿主：宿主 ID、挂载文件相对路径及是否为字幕宿主。 */
export type Mount = { host: string; file: string; captions: boolean }

/**
 * 汇总当前工程全部画布可编辑图层：包含主文件根下的可视元素（如视频片段）、各元素/模板宿主自身（`host: true`），
 * 以及字幕场景内的单句字幕元素（元素/模板组件文件内部元素不入表）。
 *
 * @param main 主文件当前 HTML 内容
 * @param mounts 主文件根下的挂载宿主列表（按源码顺序）
 * @param contents 当前已加载的工程文件内容表（路径 → 内容；字幕场景未加载时跳过字幕层）
 */
export function canvasLayersOf(
  main: string,
  mounts: readonly Mount[],
  contents: ReadonlyMap<string, string>,
): CanvasLayer[] {
  const page = new DOMParser().parseFromString(main, 'text/html')
  const root = page.querySelector('[data-composition-id]')
  if (root === null) return []
  const hosts = new Set(mounts.flatMap((mount) => (mount.captions ? [] : [mount.host])))
  const layers = layersIn(
    root,
    'index.html',
    null,
    (top) => top.getAttribute('data-hf-id') ?? '',
    hosts,
  )
  for (const mount of mounts) {
    const content = mount.captions ? contents.get(mount.file) : undefined
    if (content === undefined) continue
    layers.push(
      ...layersIn(
        mountedPart(content),
        mount.file,
        mount.host,
        (top) => top.getAttribute('data-hf-id') ?? undefined,
      ),
    )
  }
  return layers
}
