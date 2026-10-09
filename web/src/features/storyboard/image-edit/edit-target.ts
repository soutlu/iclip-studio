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

/** 编辑器上随所在页面变的几句话，与主操作的样子。 */
export type EditorWords = {
  /** 版本条第一格、对比时左边：这张图正在用的那一版。 */
  current: string
  /** 对比时的主操作。 */
  replace: string
  /** 主操作进行中按钮上的字。 */
  replacing: string
  /** 主操作做完、撤销入口旁边的那句。 */
  replaced: string
  /** 主操作的样子：分镜页替换当前帧用主色；制作页的选用不是生成，不用主色（主色只给生成）。 */
  replaceTone: 'primary' | 'neutral'
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
  gone: '该帧已不在分镜中，请关闭窗口后重新选择',
  replace: '替换当前帧',
  replaceNote: '替换仅影响当前帧，替换后可撤销',
  replaceTone: 'primary',
  replaced: '已替换',
  replacing: '正在替换…',
  versions: '该帧的图片',
}

const FILM_WORDS: EditorWords = {
  aspectNote: (aspectRatio) => `画幅 ${aspectRatio}`,
  current: '在用',
  frames: '图',
  gone: '该图片已不在分镜中，请关闭窗口后重新选择',
  replace: '选用该图片',
  replaceNote: '选用后，所有用到该图片的位置都将换成此图，可撤销',
  replaceTone: 'neutral',
  replaced: '已选用',
  replacing: '正在选用…',
  versions: '该图片的版本',
}

export const editorWordsOf = (target: FrameEditTarget): EditorWords =>
  isFilmTarget(target) ? FILM_WORDS : FRAME_WORDS
