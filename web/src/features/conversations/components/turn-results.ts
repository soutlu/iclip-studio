/** 一轮跑完后的结果入口：这一轮里写成、改成的工作区文件。只认调用自己的终态，不推断。 */

import type { TranscriptFrame } from '@/shared/transcript/vendor'
import { toolCard } from './tool-display'

export type TurnResult = {
  /** 规范化后的工作区路径。 */
  path: string
  /** 这一轮里对它最后一次成功的操作。 */
  operation: 'write' | 'edit'
}

/** 按第一次出现的顺序去重；同一份文件写过又改过，记最后那次。 */
export const turnResults = (frames: readonly TranscriptFrame[]): TurnResult[] => {
  const results = new Map<string, TurnResult>()
  for (const frame of frames) {
    if (frame.kind !== 'tool' || frame.state !== 'done') continue
    const { file, operation } = toolCard(frame.display, frame.view)
    if (file === undefined || (operation !== 'write' && operation !== 'edit')) continue
    const existing = results.get(file)
    if (existing === undefined) results.set(file, { operation, path: file })
    else existing.operation = operation
  }
  return [...results.values()]
}
