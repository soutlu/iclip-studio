import { useState, type ComponentType } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import { deletePreview, openPreview } from '../agent-previews.api'

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

/** 一段测试预览：哪个 agent 的草稿或哪一版，开了没有，第几次「新建测试对话」。 */
type Slot = {
  key: string
  agentId: string
  versionId: string | null
  previewId: string | null
  generation: number
}

const slotKey = (agentId: string, versionId: string | null) => `${agentId}|${versionId ?? 'draft'}`

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
 * 右栏的测试预览：「测试预览」「运行过程」两页与「新建测试对话」。每个 agent 的草稿与每一版各有一段自己的试聊，
 * 第一条消息发出时才开；切走再切回来，开过的那段连同输入、消息与滚动位置都还在：看不见的几段叠在下面、不卸载。
 * 「新建测试对话」删掉这一段预览，换一段还没开的。
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
  const [resetting, setResetting] = useState(false)

  const key = slotKey(agentId, versionId)
  const known = slots.find((slot) => slot.key === key)
  const current: Slot = known ?? { agentId, generation: 0, key, previewId: null, versionId }
  const all = known === undefined ? [...slots, current] : slots

  /** 改一段的记录；那一段还只是渲染时补上的（没进过 state）就先补进去。 */
  const update = (slot: Slot, patch: Partial<Slot>) =>
    setSlots((previous) => {
      const exists = previous.some((item) => item.key === slot.key)
      const base = exists ? previous : [...previous, slot]
      return base.map((item) => (item.key === slot.key ? { ...item, ...patch } : item))
    })

  const reset = async () => {
    if (current.previewId === null) return
    setResetting(true)
    try {
      await deletePreview(current.agentId, current.previewId)
      update(current, { generation: current.generation + 1, previewId: null })
    } catch (error) {
      toast.error(errorMessageOf(error, '测试对话清空失败，请重试'))
    } finally {
      setResetting(false)
    }
  }

  // 版本号只知道正在看的那一版；看不见的几段不显示，提示写泛一点无妨。
  const placeholderOf = (slot: Slot) =>
    slot.versionId === null
      ? '输入需求，或添加参考素材…'
      : slot.key === key && versionNumber !== undefined
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
          disabled={current.previewId === null || resetting}
          label="新建测试对话"
          name="refresh"
          onClick={() => void reset()}
          size="md"
        />
      </header>
      <div className="relative min-h-0 flex-1">
        {all.map((slot) => {
          const shown = slot.key === key
          return (
            <div
              aria-hidden={shown ? undefined : true}
              className={cn('absolute inset-0 flex flex-col', !shown && 'invisible')}
              inert={!shown}
              key={`${slot.key}#${slot.generation}`}
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
