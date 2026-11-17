import type { JsonPatchOp } from '@hyperframes/sdk'

/**
 * 预览里视频、音频元素的加载方式，整份文档和补丁后加进来的元素用的是这同一条规则；只改预览，存着的文件不动。
 * preload 写 none 时运行时按播放位置调 load()，一次只加载用得到的片段；写 metadata 会一开始就下载，运行时之后
 * 设成 none 也停不下来，几个文件会一起抢带宽。音频片段在文件里不写 preload，这里补上。没有 crossorigin 时
 * 运行库不经 Web Audio 管声音。
 */
export const withPreviewMediaTags = (html: string): string =>
  html
    .replaceAll('<video ', '<video crossorigin="anonymous" ')
    .replaceAll('preload="auto"', 'preload="none"')
    .replaceAll('<audio ', '<audio crossorigin="anonymous" preload="none" ')

const ADDED_ELEMENT = /^\/elements\/[^/]+$/

/** 补丁里加进来的元素（`/elements/<id>` 的 add、replace）照 `withPreviewMediaTags` 改写；别的补丁原样。 */
export const withPreviewMediaPatches = (patches: readonly JsonPatchOp[]): JsonPatchOp[] =>
  patches.map((patch) => {
    const { value } = patch
    if (
      patch.op === 'remove' ||
      !ADDED_ELEMENT.test(patch.path) ||
      typeof value !== 'object' ||
      value === null ||
      !('html' in value) ||
      typeof value.html !== 'string'
    )
      return patch
    return { ...patch, value: { ...value, html: withPreviewMediaTags(value.html) } }
  })
