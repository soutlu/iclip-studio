/** 轮尾的结果入口：这一轮写成、改成的文件各一条，点了在工作台打开；只有悬停暗示，不写「查看」。 */

import { Icon } from '@/shared/icons'
import { baseName } from '@/shared/lib/file-kind'
import { useWorkspaceFileLink } from '@/shared/workbench'
import type { TurnResult } from './turn-results'

const OPERATION_LABELS = { edit: '已编辑', write: '已写入' } as const

export function TurnResultList({ results }: { results: readonly TurnResult[] }) {
  const link = useWorkspaceFileLink()
  return (
    <ul aria-label="本轮结果" className="flex flex-col">
      {results.map((result) => (
        <li key={result.path}>
          <button
            className="group/result -mx-1.5 flex w-[calc(100%+12px)] ui-state cursor-pointer items-center gap-3 rounded-md py-1.5 pr-2.5 pl-1.5 text-left ui-focus"
            onClick={() => link.open(result.path)}
            title="在工作台打开"
            type="button"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-chat-inline-bg text-chat-muted-text">
              <Icon decorative name="file" size="md" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-body font-medium text-chat-message-text decoration-1 underline-offset-3 group-hover/result:underline">
                {baseName(result.path)}
              </span>
              <span className="text-body-sm text-chat-muted-text">
                {OPERATION_LABELS[result.operation]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
