/** 画幅的档位与解析：档位清单、「宽:高」字符串换成宽高比，全站只此一份。 */

import { zTaskVideoSpecInput } from '@/shared/api/generated/zod.gen'

/** 画幅档位：取需求单合同里的那份枚举，需求单与分镜页共用一份，顺序即下拉顺序。
 *
 * 必须从生成物取、不能改写成手写数组：需求单表单靠它把输入 narrow 回合同枚举，
 * 手写一份就会在合同加档位时悄悄对不上。 */
export const ASPECT_RATIOS = zTaskVideoSpecInput.shape.aspect_ratio.unwrap().unwrap().options

/** 画面尺寸不在数据里，占位按画幅；认不出的（如 adaptive）按竖版 9:16 占位。 */
const FALLBACK_ASPECT = { h: 16, w: 9 } as const

const RATIO = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/

/** 「宽:高」换成宽、高两个正数；缺失或读不出来时按 9:16。 */
export const aspectOf = (aspectRatio: string | null): { w: number; h: number } => {
  const match = aspectRatio === null ? null : RATIO.exec(aspectRatio)
  const w = Number(match?.[1])
  const h = Number(match?.[2])
  return w > 0 && h > 0 ? { h, w } : FALLBACK_ASPECT
}

/** 宽高比数值，可直接当 CSS `aspect-ratio`；规则同 {@link aspectOf}。 */
export const aspectValueOf = (aspectRatio: string | null): number => {
  const { w, h } = aspectOf(aspectRatio)
  return w / h
}
