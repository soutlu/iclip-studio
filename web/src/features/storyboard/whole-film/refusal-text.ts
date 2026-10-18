import { MAX_FILM_MS, MAX_VIDEO_CLIPS, MIN_CLIP_MS } from './editing/draft'
import type { Refusal } from './editing/result'

const seconds = (ms: number) => `${ms / 1000} 秒`

/** 编辑被拒时给人看的那句：原因与可以怎么做（界面文字规范见 ADR-0001）。 */
export const REFUSAL_TEXT: Readonly<Record<Refusal, string>> = {
  'unknown-clip': '这一段已不在成片里，无法操作；请重新选择',
  'unknown-source': '素材信息还没读到，无法加入成片；请稍后再试',
  'unknown-music': '音乐信息还没读到，无法使用；请稍后再试',
  'not-a-video': '片头片尾没有原声，无法调整原声音量',
  'outside-source': '所选范围超出素材，无法加入成片；请重新选择范围',
  'too-short': `片段短于 ${seconds(MIN_CLIP_MS)}，无法加入成片；请选择更长的范围`,
  'film-too-long': `加入后整片超过 ${seconds(MAX_FILM_MS)}，无法加入；请先缩短或删除其他片段`,
  'too-many-clips': `成片已有 ${MAX_VIDEO_CLIPS} 段视频，无法再加；请先删除不需要的片段`,
  'edge-not-editable': '片头只能拖右端，片尾只能拖左端',
  'end-card-exists': '成片已有片头或片尾，无法再加',
  'not-a-cut': '最后一段后面没有切点，无法放转场',
  'unknown-component': '组件库里没有这个组件，无法使用',
  'transition-does-not-fit':
    '切点前后的片段太短，放不下转场；请先加长相邻片段，或删掉这个切点上的转场',
  'nothing-to-split': `播放头不在视频段中间，无法拆分；请把播放头移到离两端都超过 ${seconds(MIN_CLIP_MS)} 的位置`,
  'no-room': '播放头处没有空位，无法放包装；请把播放头移到空处',
  'no-music': '还没有选用音乐，无法卡点；请先在「素材」里点「用这首」',
  'no-beats': '这首音乐还没有拍点，无法卡点',
  'no-cut': '成片里还没有切点，无法放转场；请先加入至少两段',
  'drop-elsewhere':
    '这里放不了这个组件；片头片尾、转场拖到画面轨，包装拖到包装轨，字幕样式拖到字幕轨',
}
