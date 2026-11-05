import type { TranscriptFrame } from '@/shared/transcript/vendor'
import { toolCard } from './tool-display'

export type TurnResult = {
  path: string
  operation: 'write' | 'edit'
}

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
