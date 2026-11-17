import type { HfAudioFxNumberParam } from '@hyperframes/core/audio-fx'
import {
  fromUnit,
  toUnit,
} from './vendor/hyperframes-studio/player/components/automationLaneGeometry'

/**
 * 效果的数字参数在「属性」滑杆上怎么走、怎么显示，全按 core 里这个参数的定义（范围、步长、单位、刻度）：
 * 线性的一格是一个步长；标了对数刻度的（频率、时间）照参照的工作台按对数铺开，不收到步长上（同 core，只收进范围）。
 */

// 对数刻度的参数跨三四个数量级，铺成固定的格数
const LOG_POSITIONS = 200

const isLog = (param: HfAudioFxNumberParam) => param.scale === 'log' && param.min > 0

const rangeOf = (param: HfAudioFxNumberParam) => ({ ...param, scale: param.scale ?? 'linear' })

// 照参照的工作台：步长到 1 不带小数，到 0.1 一位，再小两位
const decimalsOf = (param: HfAudioFxNumberParam) =>
  param.step >= 1 ? 0 : param.step >= 0.1 ? 1 : 2

// 对数刻度的取值至少留三位有效数字（整数部分全留）：收到步长上会把下限比步长还小的一头（压缩的启动、释放）
// 挤成同一个值
const logDecimals = (value: number) =>
  value > 0 ? Math.max(0, 2 - Math.floor(Math.log10(value))) : 0

/** 收到范围里：线性的收到步长上（按显示的位数取整），对数刻度的至少留三位有效数字。 */
export const snapParam = (param: HfAudioFxNumberParam, value: number): number => {
  const rounded = isLog(param)
    ? Number(value.toFixed(logDecimals(value)))
    : Number((Math.round(value / param.step) * param.step).toFixed(decimalsOf(param)))
  return Math.min(param.max, Math.max(param.min, rounded))
}

/** 滑杆一共几格。 */
export const paramPositions = (param: HfAudioFxNumberParam): number =>
  isLog(param) ? LOG_POSITIONS : Math.round((param.max - param.min) / param.step)

/** 第 `position` 格的取值。 */
export const paramAt = (param: HfAudioFxNumberParam, position: number): number =>
  snapParam(
    param,
    isLog(param)
      ? fromUnit(rangeOf(param), position / LOG_POSITIONS)
      : param.min + position * param.step,
  )

/** 取值 `value` 在第几格。 */
export const paramPosition = (param: HfAudioFxNumberParam, value: number): number =>
  Math.round(
    isLog(param) ? toUnit(rangeOf(param), value) * LOG_POSITIONS : (value - param.min) / param.step,
  )

/** 显示的文字：数值加 core 的单位（没有单位的是比例，只写数）；对数刻度的照取值的位数显示。 */
export const paramText = (param: HfAudioFxNumberParam, value: number): string =>
  `${isLog(param) ? String(Number(value.toFixed(logDecimals(value)))) : value.toFixed(decimalsOf(param))}${param.unit}`

/** 输入框里的文字读成数值（后面的单位可带可不带）；读不出时是 null。 */
export const parseParamText = (text: string): number | null => {
  const matched = /^([-+]?\d*\.?\d+)/.exec(text.trim())
  if (matched?.[1] === undefined) return null
  const value = Number(matched[1])
  return Number.isFinite(value) ? value : null
}
