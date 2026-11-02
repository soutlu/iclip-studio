import { useState, type ComponentType } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { openPreview } from '../agent-previews.api'

/** 右栏这一刻看的：试聊的对话，还是这段试聊的运行过程。 */
export type PreviewView = 'chat' | 'trace'

/** 交给对话组件画一段测试预览所需的一切；对话组件属于对话模块，由路由层接进来。 */
export type PreviewConversationProps = {
  /** 预览 id，当对话 id 用；第一条消息发出前还没开，为 null。 */
  previewId: string | null
  /** 第一次发送时开预览，交回预览 id。 */
  openPreview: () => Promise<string>
  placeholder: string
  view: PreviewView
}

/** 一个 agent 的那段测试预览：试的是草稿还是哪一版，开了没有，第几次换成没开的一段。 */
type Slot = {
  agentId: string
  versionId: string | null
  previewId: string | null
  generation: number
}

type PreviewHostProps = {
  agentId: string
  /** 正在看的历史版本；看草稿时为 null。 */
  versionId: string | null
  /** 正在看的历史版本的版本号，读到之前为 undefined。 */
  versionNumber: number | undefined
  /** 右栏此刻被配置面板占着或 agent 还没读到：预览照样留着（输入、消息与滚动位置都在），只是看不见。 */
  hidden: boolean
  Conversation: ComponentType<PreviewConversationProps>
}

/**
 * 右栏的测试预览：「测试预览」「运行过程」两页与「新建测试对话」。每个 agent 一段试聊，对应后端每人每个 agent
 * 一段当前预览，第一条消息发出时才开；切到别的 agent 再切回来，开过的那段连同输入、消息与滚动位置都还在：
 * 看不见的几段叠在下面、不卸载。正在看的从草稿换成某一版、或从一版换成另一版，这个 agent 的那段就换成还没开的
 * 新一段，原来的不再显示。「新建测试对话」也只是换成还没开的一段，不发请求；下一条消息开新预览时后端换掉旧的。
 */
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
  // 试的目标变了：在这次渲染里就换成新的一段，免得先闪一帧旧的；换的那次提交后 known 就对上了。
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

  /** 改一段的记录，只改还是同一次（generation 没变）的那段；那一段还只是渲染时补上的就先补进去。 */
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

  // 版本号只知道正在看的那一版；看不见的几段不显示，提示写泛一点无妨。
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
        'absolute inset-y-0 right-0 flex w-1/2 min-w-0 flex-col bg-background max-md:hidden',
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
