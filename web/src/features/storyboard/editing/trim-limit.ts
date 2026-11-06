import { roundSeconds } from './time-label'

export const TRIM_LIMIT_TEXT = {
  start: '已到这段的开头',
  end: '已到这段的结尾',
  shortest: (seconds: number) => `最短 ${roundSeconds(seconds)} 秒`,
}
