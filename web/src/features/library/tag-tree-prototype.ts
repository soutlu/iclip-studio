/** 本地交互原型入口；仅 mock 模式启用，不连接线上标签或打标队列。 */
declare const __TAG_TREE_PROTOTYPE__: boolean

export const isTagTreePrototype = (): boolean =>
  typeof __TAG_TREE_PROTOTYPE__ !== 'undefined' &&
  __TAG_TREE_PROTOTYPE__ &&
  new URLSearchParams(window.location.search).get('variant') === 'tag-tree'
