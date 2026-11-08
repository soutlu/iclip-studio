import { filmMetadata, storyboardMetadata } from '../generation-metadata'
import type { FrameEditTarget } from './image-edit-types'

type FilmImageTarget = Extract<FrameEditTarget, { node: string }>

export const isFilmTarget = (target: FrameEditTarget): target is FilmImageTarget => 'node' in target

export const editTargetMetadata = (target: FrameEditTarget): Record<string, unknown> =>
  isFilmTarget(target)
    ? filmMetadata(target.node)
    : storyboardMetadata(target.shotIndex, target.frameNumber)

export const editTargetKeyParts = (target: FrameEditTarget): readonly (string | number)[] =>
  isFilmTarget(target) ? ['film', target.node] : [target.shotIndex, target.frameNumber]

export type EditorWords = {
  current: string
  replace: string
  replacing: string
  replaced: string
  replaceTone: 'primary' | 'neutral'
  gone: string
  replaceNote: string
  versions: string
  frames: string
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
