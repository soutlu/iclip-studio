import type { JsonPatchOp } from '@hyperframes/sdk'
import { PROJECT_MAIN } from './composition/film'
import type { PatchChange, UndoStep } from './undo-history'

/** 交给预览页的一份 final-cut。 */
export type PreviewFilm = {
  /** 整份预览文档（见 `previewDocument`）。 */
  html: string
  /** 预览域名下的运行库地址（见 `previewRuntimeSrc`）。 */
  runtimeSrc: string
  /** 编辑器里的第几份（见 `FilmView.revision`）。 */
  revision: number
  /** 从上一份到这一份的那一步编辑（见 `FilmView.step`）。 */
  step: UndoStep | null
  /** 预览套着一种外语。 */
  foreign: boolean
  /** 工程里主文件和值表以外的文件变过几次；变了要整份重新加载。 */
  filesRevision: number
}

/** 换上一份 final-cut 的办法：把这些补丁直接打进正在播的那一份，或者整份重新加载。 */
export type PreviewSync = { kind: 'live'; patches: readonly JsonPatchOp[] } | { kind: 'reload' }

const RELOAD: PreviewSync = { kind: 'reload' }

const headOf = (html: string) => /<head[^>]*>[\s\S]*?<\/head>/i.exec(html)?.[0] ?? ''

// 实测过打进去和重新加载效果一样的几种改动；别的（贴片、场景宿主的值、变量、脚本……）运行库只在加载时读
const LIVE_TIMING = new Set(['start', 'duration', 'trackIndex'])
const LIVE_ATTRIBUTES = new Set(['data-hidden', 'data-media-start', 'data-volume', 'muted'])
const LIVE_STYLES = new Set(['zIndex'])

const isMediaElement = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  'html' in value &&
  typeof value.html === 'string' &&
  /^\s*<(video|audio)[\s>]/i.test(value.html)

const isLive = (patch: JsonPatchOp): boolean => {
  if (patch.path === '/metadata/duration') return true
  const element = /^\/elements\/[^/]+(?:\/([^/]+)\/(.+))?$/.exec(patch.path)
  if (element === null) return false
  const [, kind, name = ''] = element
  switch (kind) {
    // 加、删片段本身：删哪种都行，加的只能是视频、音频（宿主要运行库挂载）
    case undefined:
      return patch.op === 'remove' || isMediaElement(patch.value)
    case 'timing':
      return LIVE_TIMING.has(name)
    case 'attributes':
      return LIVE_ATTRIBUTES.has(name)
    case 'inlineStyles':
      return LIVE_STYLES.has(name)
    default:
      return false
  }
}

/** 补丁里最后写下的总长（秒）；没写时是 undefined。 */
const durationIn = (patches: readonly JsonPatchOp[]) =>
  patches.findLast((patch) => patch.path === '/metadata/duration' && patch.op !== 'remove')?.value

// 运行库的总长只能往长里改（预览页经它的 set-root-duration 改），变短时整份重新加载
const shortens = (change: PatchChange) => {
  const after = durationIn(change.patches)
  if (after === undefined) return false
  const before = durationIn(change.inversePatches)
  return typeof after !== 'number' || typeof before !== 'number' || after < before
}

/**
 * 预览页装着 `shown`（还没装好或正在重新加载时是 null）、要换成 `next` 时怎么换：这一步只改了主文件、改的都是能直接
 * 打进去的那几种、总长没变短，而且 `next` 正好是 `shown` 的下一份、`<head>`（字体块、语言、基准地址）和别的条件
 * 都没变时，把这一步主文件的补丁打进去；拿不准的都整份重新加载。
 */
export function previewSync(shown: PreviewFilm | null, next: PreviewFilm): PreviewSync {
  const { step } = next
  if (
    shown === null ||
    step === null ||
    next.revision !== shown.revision + 1 ||
    next.foreign ||
    shown.foreign ||
    next.runtimeSrc !== shown.runtimeSrc ||
    next.filesRevision !== shown.filesRevision ||
    headOf(next.html) !== headOf(shown.html) ||
    step.some((change) => change.file !== PROJECT_MAIN || shortens(change))
  )
    return RELOAD
  const patches = step.flatMap((change) => change.patches)
  return patches.every(isLive) ? { kind: 'live', patches } : RELOAD
}
