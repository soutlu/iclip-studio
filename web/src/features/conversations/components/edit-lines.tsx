/** 一次编辑改了哪些行：审批卡预览与工具行详情共用。相同的首尾行当上下文，删掉的行灰色划线，新写的行墨色加浅灰底，不用红绿。 */

import { cn } from '@/shared/lib/utils'
import { diffLinesOf } from './tool-display'

const EDIT_MARKS = { added: '+', context: '', removed: '−' } as const

export function EditLines({ after, before }: { after: string; before: string }) {
  // 同一段里可能有相同的行，key 用「第几行」；序号在这里算好，不在渲染时取下标。
  const lines = diffLinesOf(before, after).map((line, index) => ({ ...line, id: index }))
  return lines.map((line) => (
    <div
      className={cn(
        'flex gap-2 px-3',
        line.kind === 'removed' && 'text-chat-muted-text',
        line.kind === 'added' && 'bg-state-active',
      )}
      key={line.id}
    >
      <span aria-hidden className="w-2.5 shrink-0 text-center text-chat-muted-text">
        {EDIT_MARKS[line.kind]}
      </span>
      {line.kind === 'context' ? null : (
        <span className="sr-only">{line.kind === 'removed' ? '删去：' : '新写：'}</span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 break-words whitespace-pre-wrap',
          line.kind === 'removed' && 'line-through',
        )}
      >
        {/* 空行留一个空格撑住行高。 */}
        {line.text === '' ? ' ' : line.text}
      </span>
    </div>
  ))
}
