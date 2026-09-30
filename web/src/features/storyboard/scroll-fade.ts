/** 横向滚动行还能往哪边滚：出片栏参数行与成片区共用，样式按它给那一端加渐隐。 */

export type ScrollFade = 'none' | 'start' | 'end' | 'both'

/** 左边滚过了就还能往回滚；右边留 1px 容差，缩放后的小数宽度不会让它在滚到头时仍亮着。
 * 内容放得下时两端都滚不动，为 none。 */
export const scrollFadeOf = ({
  clientWidth,
  scrollLeft,
  scrollWidth,
}: {
  clientWidth: number
  scrollLeft: number
  scrollWidth: number
}): ScrollFade => {
  const start = scrollLeft > 0
  const end = scrollLeft + clientWidth < scrollWidth - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
}
