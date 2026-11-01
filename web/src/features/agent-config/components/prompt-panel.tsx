import { MarkdownEditor } from '@/shared/ui/markdown-editor'
import { PanelShell } from './panel-shell'

/** 系统提示词的全文编辑；改动直接写进草稿，「完成」只是收起面板。 */
export function PromptPanel({
  onChange,
  onClose,
  value,
}: {
  value: string
  onChange: (markdown: string) => void
  onClose: () => void
}) {
  return (
    <PanelShell onClose={onClose} scroll={false} title="系统提示词">
      <MarkdownEditor
        ariaLabel="系统提示词"
        className="max-w-180 flex-1"
        onChange={onChange}
        placeholder="描述这个 Agent 的角色、工作方式与表达准则"
        value={value}
      />
    </PanelShell>
  )
}
