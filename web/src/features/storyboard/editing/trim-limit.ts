import { roundSeconds } from './time-label'

export const TRIM_LIMIT_TEXT = {
  start: '已到达该片段起点',
  end: '已到达该片段终点',
  shortest: (seconds: number) => `最短 ${roundSeconds(seconds)} 秒`,
}
