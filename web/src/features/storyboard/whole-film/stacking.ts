import type { PictureBlock } from './composition/film'
import {
  computeStackingPatches,
  type StackingElement,
} from './vendor/hyperframes-studio/player/components/timelineStackingSync'

const overlaps = (
  left: Pick<PictureBlock, 'start' | 'duration'>,
  right: Pick<PictureBlock, 'start' | 'duration'>,
) => left.start < right.start + right.duration && right.start < left.start + left.duration

/**
 * 把 `block` 放进成片时，它该写在文件的第几个、叠放顺序是多少，才能被上面的行盖住、盖住下面的行。
 * 新加一个块、把一个块换到另一行（先取出来再放回去）都用它。
 *
 * `pictures` 是别的块，按它们在文件里的先后给。谁盖住谁先看叠放顺序，一样大时写在后面的在上面；
 * 行号小的行在上面。别的块一律不动：先靠写的位置——写在时间上重叠的、在它上面的行里最靠前的
 * 那个块之前，没有就写在最后；这样还盖不住下面某个块时，再把它的叠放顺序调到比那个块高。
 */
export const insertionOf = (
  pictures: readonly PictureBlock[],
  block: PictureBlock,
): { index: number; z: number } => {
  const above = pictures.flatMap((other, at) =>
    other.track < block.track && overlaps(other, block) ? [at] : [],
  )
  const index = above.length === 0 ? pictures.length : Math.min(...above)
  const written = [...pictures.slice(0, index), { ...block, z: 0 }, ...pictures.slice(index)]
  const elements: StackingElement[] = written.map((other, domIndex) => ({
    key: other.id,
    start: other.start / 1000,
    duration: other.duration / 1000,
    track: other.track,
    zIndex: other.z,
    isAudio: false,
    domIndex,
  }))
  return { index, z: computeStackingPatches(elements, [block.id], 'up')[0]?.zIndex ?? 0 }
}
