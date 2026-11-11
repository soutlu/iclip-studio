import { useState, type ComponentType } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { openPreview } from '../agent-previews.api'

export type PreviewView = 'chat' | 'trace'

export type PreviewConversationProps = {
  agentId: string
  /** 测的是草稿（没有选定某个已发布版本）。 */
  draft: boolean
  previewId: string | null
  openPreview: () => Promise<string>
  placeholder: string
  view: PreviewView
}

type Slot = {
  agentId: string
  versionId: string | null
  previewId: string | null
  generation: number
}

type PreviewHostProps = {
  agentId: string
  versionId: string | null
  versionNumber: number | undefined
  hidden: boolean
  Conversation: ComponentType<PreviewConversationProps>
}

export function PreviewHost({
  agentId,
  hidden,
  Conversation,
  versionId,
  versionNumber,
}: PreviewHostProps) {
  const [view, setView] = useState<PreviewView>('chat')
  const [slots, setSlots] = useState<readonly Slot[]>([])

  const known = slots.find((slot) => slot.agentId === agentId)
  const retargeted = known !== undefined && known.versionId !== versionId
  if (retargeted)
    setSlots((previous) =>
      previous.map((slot) =>
        slot.agentId === agentId
          ? { ...slot, generation: slot.generation + 1, previewId: null, versionId }
          : slot,
      ),
    )
  const current: Slot =
    known === undefined
      ? { agentId, generation: 0, previewId: null, versionId }
      : retargeted
        ? { ...known, generation: known.generation + 1, previewId: null, versionId }
        : known
  const all =
    known === undefined
      ? [...slots, current]
      : slots.map((slot) => (slot.agentId === agentId ? current : slot))

  const update = (slot: Slot, patch: Partial<Slot>) =>
    setSlots((previous) => {
      const base = previous.some((item) => item.agentId === slot.agentId)
        ? previous
        : [...previous, slot]
      return base.map((item) =>
        item.agentId === slot.agentId && item.generation === slot.generation
          ? { ...item, ...patch }
          : item,
      )
    })

  const reset = () => update(current, { generation: current.generation + 1, previewId: null })

  const placeholderOf = (slot: Slot) =>
    slot.versionId === null
      ? '输入需求，或添加参考素材…'
      : slot.agentId === agentId && versionNumber !== undefined
        ? `用 v${versionNumber} 测试…`
        : '用这一版测试…'

  return (
    <section
      aria-hidden={hidden ? true : undefined}
      aria-label="Agent 预览"
      className={cn(
        'absolute inset-y-0 right-0 left-(--agent-config-split) flex min-w-0 flex-col bg-background max-md:hidden',
        hidden && 'invisible',
      )}
      inert={hidden}
    >
      <header className="flex h-15 shrink-0 items-stretch gap-2 border-b border-hairline pr-4 pl-5">
        <TabsRoot
          className="flex min-w-0 flex-1"
          onValueChange={(value) => setView(value === 'trace' ? 'trace' : 'chat')}
          value={view}
        >
          <TabsList aria-label="预览内容">
            <TabsTrigger value="chat">测试预览</TabsTrigger>
            <TabsTrigger value="trace">运行过程</TabsTrigger>
          </TabsList>
        </TabsRoot>
        <IconButton
          className="self-center"
          disabled={current.previewId === null}
          label="新建测试对话"
          name="refresh"
          onClick={reset}
          size="md"
        />
      </header>
      <div className="relative min-h-0 flex-1">
        {all.map((slot) => {
          const shown = slot.agentId === agentId
          return (
            <div
              aria-hidden={shown ? undefined : true}
              className={cn('absolute inset-0 flex flex-col', !shown && 'invisible')}
              inert={!shown}
              key={`${slot.agentId}#${slot.generation}`}
            >
              <Conversation
                agentId={slot.agentId}
                draft={slot.versionId === null}
                openPreview={async () => {
                  const id = await openPreview(slot.agentId, slot.versionId)
                  update(slot, { previewId: id })
                  return id
                }}
                placeholder={placeholderOf(slot)}
                previewId={slot.previewId}
                view={view}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}
