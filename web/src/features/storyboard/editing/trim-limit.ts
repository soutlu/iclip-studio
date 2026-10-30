import { roundSeconds } from './time-label'

/**
 * 修剪把手拖到边界停住时把手旁气泡里的说明（界面文字规范见 ADR-0001），两个编辑器、各种块共用：到了这段素材
 * 本身的开头（`start`）、结尾（`end`），或剪到了最短（各编辑器自己的最短时长）。成片总长上限另见成片的
 * `FILM_LIMIT_TEXT`。
 */
export const TRIM_LIMIT_TEXT = {
  start: '已到这段的开头',
  end: '已到这段的结尾',
  shortest: (seconds: number) => `最短 ${roundSeconds(seconds)} 秒`,
}
