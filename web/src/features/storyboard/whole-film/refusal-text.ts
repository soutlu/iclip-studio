import { MAX_FILM_MS, MIN_CLIP_MS } from './editing/draft'
import type { Refusal } from './editing/result'

const seconds = (ms: number) => `${ms / 1000} 秒`

/** 编辑被拒时给人看的那句：原因与可以怎么做（界面文字规范见 ADR-0001）。 */
export const REFUSAL_TEXT: Readonly<Record<Refusal, string>> = {
  'unknown-clip': '这一段已不在成片里，无法操作；请重新选择',
  'unknown-source': '素材信息还没读到，无法加入成片；请稍后再试',
  'unknown-music': '音乐信息还没读到，无法使用；请稍后再试',
  'not-a-video': '组件段没有原声，无法调整原声音量',
  'outside-source': '所选范围超出素材，无法加入成片；请重新选择范围',
  'too-short': `片段短于 ${seconds(MIN_CLIP_MS)}，无法加入成片；请选择更长的范围`,
  'film-too-long': `加入后成片超过 ${seconds(MAX_FILM_MS)}，无法加入；请先缩短或删除其他片段`,
  'overlay-too-long': `从这里放会在 ${seconds(MAX_FILM_MS)} 之后结束，无法加入；请把播放头往前移`,
  'nothing-to-split': `播放头不在片段中间，无法拆分；请把播放头移到离两端都超过 ${seconds(MIN_CLIP_MS)} 的位置`,
  'no-music': '还没有选用音乐，无法卡点；请先在「素材」里点「用这首」',
  'no-beats': '这首音乐还没有拍点，无法卡点',
  'drop-elsewhere': '这里放不了这个组件；字幕样式拖到字幕轨，其他组件拖到画面轨或特效轨',
}

/** 拖长、挪动到成片总长上限时停住的原因 */
export const FILM_LIMIT_TEXT = `成片最长 ${seconds(MAX_FILM_MS)}，不能再拉长`
