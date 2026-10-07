/** 编辑器按开在哪张图上分的几处：记录怎么标、怎么查，草稿存在哪，舞台与版本条上怎么称呼它。
 * 分镜页的图是第几组的第几帧，记录标 `{shot, frame}`；制作页的图是工程里的一张图，记录标 `{film_node}`，
 * 同一张图在几组里用到也只有一份历史。 */

import { filmMetadata, storyboardMetadata } from '../generation-metadata'
import type { FrameEditTarget } from './image-edit-types'

type FilmImageTarget = Extract<FrameEditTarget, { node: string }>

export const isFilmTarget = (target: FrameEditTarget): target is FilmImageTarget => 'node' in target

/** 这张图的编辑与生成记录在 `metadata` 上的标记：提交时写上，列表按它筛。 */
export const editTargetMetadata = (target: FrameEditTarget): Record<string, unknown> =>
  isFilmTarget(target)
    ? filmMetadata(target.node)
    : storyboardMetadata(target.shotIndex, target.frameNumber)

/** 查询键与草稿键里认这张图的几段。 */
export const editTargetKeyParts = (target: FrameEditTarget): readonly (string | number)[] =>
  isFilmTarget(target) ? ['film', target.node] : [target.shotIndex, target.frameNumber]

/** 编辑器上随所在页面变的几句话。 */
export type EditorWords = {
  /** 版本条第一格、对比时左边：这张图正在用的那一版。 */
  current: string
  /** 对比时的主操作。 */
  replace: string
  /** 这张图已经不在分镜里了。 */
  gone: string
  /** 选中一张结果时的脚注。 */
  replaceNote: string
  /** 版本条的可访问名。 */
  versions: string
  /** 输入卡 `@` 菜单与「+」里本组图片的统称。 */
  frames: string
  /** 没选结果时的脚注：编辑出来的图用什么画幅。 */
  aspectNote: (aspectRatio: string) => string
}

const FRAME_WORDS: EditorWords = {
  aspectNote: (aspectRatio) => `画幅 ${aspectRatio}，跟随分镜`,
  current: '当前帧',
  frames: '帧',
  gone: '这一帧已经不在分镜里了，关掉窗口重新选一帧',
  replace: '替换当前帧',
  replaceNote: '替换只改当前帧，替换后可以撤销',
  versions: '这一帧的图片',
}

const FILM_WORDS: EditorWords = {
  aspectNote: (aspectRatio) => `画幅 ${aspectRatio}`,
  current: '在用',
  frames: '图',
  gone: '这张图已经不在分镜里了，关掉窗口重新选一张',
  replace: '替换这张图',
  replaceNote: '替换后，用到这张图的地方都换成它，可以撤销',
  versions: '这张图的版本',
}

export const editorWordsOf = (target: FrameEditTarget): EditorWords =>
  isFilmTarget(target) ? FILM_WORDS : FRAME_WORDS
