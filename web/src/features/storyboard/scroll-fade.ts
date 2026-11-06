export type ScrollFade = 'none' | 'start' | 'end' | 'both'

export const scrollFadeOf = ({
  clientWidth,
  scrollLeft,
  scrollWidth,
}: {
  clientWidth: number
  scrollLeft: number
  scrollWidth: number
}): ScrollFade => {
  const start = scrollLeft > 1
  const end = scrollLeft + clientWidth < scrollWidth - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
}
