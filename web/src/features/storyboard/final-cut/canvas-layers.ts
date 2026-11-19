import { buildStableSelector, resolveLayerSelector } from '@hyperframes/core/runtime/editing-port'

/**
 * 画面上能编辑的层：按工程里各文件现在的内容列出来，编辑器和预览页都按这张表认层。预览页回报的只能是数字，
 * 层是谁由编辑器这边定：每一层写成「挂在哪个宿主下、选择器、第几个匹配」，预览页照着在画面里找到它。
 *
 * 认层的规则和运行库的一样：选择器用运行库的 `buildStableSelector`（id、`data-composition-id`、`data-hf-group`、
 * class 依次取），`resolveLayerSelector` 取不到的（带 `data-composition-id` 的宿主和合成的根）不是层，不画东西的
 * 标签不是层。同一个选择器在一个文件里第几个匹配，按文件里的先后数。
 */

/** 不画东西的标签（运行库 `isInspectableLayerElement` 跳过的那些），加上不画画面的 `<audio>`。 */
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

/** 文件里的一个元素：SDK 给它的编号（文件里的 `data-hf-id`，写回文件时按它找），和它现在的属性。 */
export type SourceElement = {
  hfId: string
  tag: string
  /** 除 `style` 以外的属性。 */
  attributes: Readonly<Record<string, string>>
}

/**
 * 画面上的一层，或者一个贴片、场景的宿主（`host`）。画面上点选、挪、缩放、转的是宿主整个（见 canvas-overlay.tsx），
 * 宿主里面的不是层。
 *
 * - `scope`：它挂在主文件里哪个宿主下（宿主的 `data-hf-id`）；主文件里的元素是 null。
 * - `selector`、`index`：在这个宿主挂载的那份内容里，第几个匹配这个选择器的元素；`count` 是文件里一共几个匹配，
 *   预览里数出来不一样（脚本加了同样的元素）时预览里找不到这一层。
 * - `file`：它写在工程里哪个文件（相对工程根）；`clip`：它属于时间线上的哪个片段（宿主、字幕、视频片段）。
 * - `locked`：它或文件里它的祖先带 `data-timeline-locked`。
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

/**
 * 文件内容 `html` 里挂载出来的那部分：有 `<template>` 时是第一个模板的内容（运行库挂载时也这么取），不然是
 * `<body>`。
 */
function mountedPart(html: string): ParentNode {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const template = page.querySelector('template')
  return template === null ? page.body : template.content
}

/**
 * 一个文件里的层：`clipOf` 按元素在合成的根下面那一层的祖先（`top`）答它属于哪个片段，答 undefined 的不要。
 * `hosts` 里的宿主（按 `data-hf-id`）也列上，标成 `host`。
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
      // 合成的根下面的每个子元素各自是一个片段
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

/** 层在表里的名字：宿主、选择器和第几个匹配连起来（选择器里不会有换行）。 */
export const layerKey = (scope: string | null, selector: string, index: number): string =>
  `${scope ?? ''}\n${selector}\n${index}`

/** 主文件根下一个挂载着文件的宿主：编号、挂载的文件（相对工程根），是不是字幕宿主。 */
export type Mount = { host: string; file: string; captions: boolean }

/**
 * 工程里画面上能编辑的层和宿主：主文件根下的元素（视频片段这些，属于它自己那个片段）、每个组件或块的宿主自己
 * （`host`），和字幕场景里的元素（属于它所在的那句字幕）。组件文件里的元素不列：贴片、场景整个是一层。
 *
 * @param main 主文件现在的内容
 * @param mounts 主文件根下挂载着文件的宿主，按文件里的先后
 * @param contents 工程里打开着的文件（路径 → 内容）；字幕场景没打开时字幕宿主下没有层
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
