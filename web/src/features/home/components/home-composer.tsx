import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ComposerHandle, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'

const LOGIN_DRAFT_KEY = 'cue.home.login-draft'
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
  /** 为 true 时聚焦输入框并调用 onFocusHandled；挂载时已为 true 也会在挂载后聚焦。 */
  focusRequested?: boolean | undefined
  onFocusHandled?: (() => void) | undefined
  /** 返回 true 后清空输入；失败提示与登录流程由路由负责。 */
  onSend?: ((submission: ComposerSubmission) => Promise<boolean>) | undefined
  /** 游客发送前仅暂存正文，供整页登录返回后恢复。 */
  preserveForLogin?: boolean | undefined
  /** 做同款：换成做同款的提示，工具行左侧放快捷词。 */
  sameStyle?: boolean | undefined
  sending?: boolean | undefined
}

/** 仅装配输入卡；运行目标、合集、权限与发送流程由路由传入。 */
export function HomeComposer({
  agentPicker,
  attachmentsEnabled = false,
  collectionPicker,
  focusRequested = false,
  onFocusHandled,
  onSend,
  preserveForLogin = false,
  sameStyle = false,
  sending = false,
}: HomeComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const submittingRef = useRef(false)

  useEffect(() => {
    try {
      const text = window.sessionStorage.getItem(LOGIN_DRAFT_KEY)
      if (text === null) return
      composerRef.current?.restore({ media: [], parts: [{ kind: 'text', text }], text })
      window.sessionStorage.removeItem(LOGIN_DRAFT_KEY)
    } catch {
      toast.error('登录前的草稿读取失败，请检查输入内容')
    }
  }, [])

  useEffect(() => {
    if (!focusRequested) return
    composerRef.current?.focus()
    onFocusHandled?.()
  }, [focusRequested, onFocusHandled])

  const send = async (submission: ComposerSubmission) => {
    if (onSend === undefined || sending || submittingRef.current) return
    if (preserveForLogin) {
      try {
        window.sessionStorage.setItem(LOGIN_DRAFT_KEY, submission.text)
      } catch {
        toast.error('输入内容暂存失败，请复制内容后登录')
        return
      }
    }
    submittingRef.current = true
    try {
      if (await onSend(submission)) {
        composerRef.current?.clear()
        try {
          window.sessionStorage.removeItem(LOGIN_DRAFT_KEY)
        } catch {
          toast.error('消息已发送，但浏览器无法清理登录前的草稿')
        }
      }
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
