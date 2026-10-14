import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerHandle, ComposerPart, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'

// 首页用一句完整的创作要求做占位，示范该写什么；对话页等其他输入框仍用默认占位。
const PLACEHOLDER = '例如：给这双白色帆布鞋写一份 15 秒的产品分镜'
// 换什么由下面的快捷词示范，占位只说一句，窄屏也放得下一行。
const SAME_STYLE_PLACEHOLDER = '参照该视频做同款，请输入要替换的内容'
/** 做同款的快捷词：点一下把句子开头插到光标处，接着写换成什么。 */
const SAME_STYLE_PHRASES = [
  { label: '换人物', text: '把人物换成' },
  { label: '换产品', text: '把产品换成' },
  { label: '换场景', text: '把场景换成' },
] as const

export type HomeComposerProps = {
  agentPicker?: ReactNode
  attachmentsEnabled?: boolean | undefined
  collectionPicker?: ReactNode
  /** 草稿里的输入框内容，只在挂载时读。 */
  draftParts?: readonly ComposerPart[] | undefined
  /** 输入内容或附件状态变化时触发，用于暂存草稿；挂载恢复不触发，发送成功后清空输入会触发一次。 */
  onDraftChange?: ((parts: readonly ComposerPart[]) => void) | undefined
  /** 为 true 时聚焦输入框并调用 onFocusHandled；挂载时已为 true 也会在挂载后聚焦。 */
  focusRequested?: boolean | undefined
  onFocusHandled?: (() => void) | undefined
  /** 返回 true 后清空输入；失败提示、登录流程与草稿删除由路由负责。 */
  onSend?: ((submission: ComposerSubmission) => Promise<boolean>) | undefined
  /** 做同款：换成做同款的提示，工具行左侧放快捷词。 */
  sameStyle?: boolean | undefined
  sending?: boolean | undefined
}

/** 仅装配输入卡；运行目标、合集、权限与发送流程由路由传入。 */
export function HomeComposer({
  agentPicker,
  attachmentsEnabled = false,
  collectionPicker,
  draftParts,
  focusRequested = false,
  onDraftChange,
  onFocusHandled,
  onSend,
  sameStyle = false,
  sending = false,
}: HomeComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const submittingRef = useRef(false)
  const [initialParts] = useState(draftParts)

  useEffect(() => {
    if (initialParts === undefined || initialParts.length === 0) return
    composerRef.current?.restore({
      media: initialParts.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
      parts: initialParts,
      text: '',
    })
  }, [initialParts])

  useEffect(() => {
    if (!focusRequested) return
    composerRef.current?.focus()
    onFocusHandled?.()
  }, [focusRequested, onFocusHandled])

  const send = async (submission: ComposerSubmission) => {
    if (onSend === undefined || sending || submittingRef.current) return
    submittingRef.current = true
    try {
      if (await onSend(submission)) composerRef.current?.clear()
    } finally {
      submittingRef.current = false
    }
  }

  return (
    <div>
      <Composer
        attachmentsEnabled={attachmentsEnabled}
        leading={
          sameStyle ? (
            <div className="flex flex-wrap items-center gap-1.5 pl-1">
              {SAME_STYLE_PHRASES.map((phrase) => (
                <button
                  className="inline-flex h-(--control-height-xs) ui-state cursor-pointer items-center rounded-full border-[0.5px] border-chat-hairline px-2.5 text-body-sm whitespace-nowrap text-on-surface-variant ui-focus"
                  key={phrase.label}
                  onClick={() => {
                    composerRef.current?.insert([{ kind: 'text', text: phrase.text }])
                    composerRef.current?.focus()
                  }}
                  type="button"
                >
                  {phrase.label}
                </button>
              ))}
            </div>
          ) : undefined
        }
        onChange={onDraftChange}
        onSubmit={(submission) => {
          void send(submission)
        }}
        placeholder={sameStyle ? SAME_STYLE_PLACEHOLDER : PLACEHOLDER}
        ref={composerRef}
        sending={sending}
        trailing={agentPicker}
      />
      {collectionPicker}
    </div>
  )
}
