import { frameJobKey } from '../frame-status'
import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { StoryboardFrameTarget } from '../image-edit/image-edit-types'
import type { GenerationJob } from '../storyboard.api'
import { frameEditTriggerSelector } from './frame-edit-trigger'

/** 打开图片编辑器的这一次：改哪一帧、先选中哪条结果、从哪个控件点开（关掉后焦点回它）。
 *
 * target 本身不带图，应用之后这一格换了图它也不用变。 */
export type FrameEditSession = {
  target: StoryboardFrameTarget
  initialKey?: string | undefined
  trigger: HTMLElement | null
}

type Props = {
  session: FrameEditSession
  frames: readonly string[]
  aspectRatio: string
  /** 各帧最新的图片任务，按 `frameJobKey` 取；关掉时那条若在编辑器里点开看过，交回去标成看过。 */
  latestFrameJobs: ReadonlyMap<string, GenerationJob>
  onClose: (seen: GenerationJob | undefined) => void
  onApply: (previousUrl: string, url: string) => Promise<void>
}

/** 阅读器里挂图片编辑器：接线之外只管一件事，关掉后焦点回到点开它的地方。 */
export function ReaderImageEdit({
  session,
  frames,
  aspectRatio,
  latestFrameJobs,
  onClose,
  onApply,
}: Props) {
  const { target } = session
  return (
    <FrameImageEditor
      key={JSON.stringify(target)}
      target={target}
      // 当前帧随替换实时变；编辑器不记打开那一刻的地址，不然替换完窗口还留着就对不上了。
      currentUrl={frames[target.frameNumber - 1]}
      subtitle={`镜头组 ${target.shotIndex} · 帧 @${target.frameNumber}`}
      frames={frames.map((url, index) => ({ name: `帧 @${index + 1}`, url }))}
      aspectRatio={aspectRatio}
      initialKey={session.initialKey}
      onClose={(opened) => {
        const latest = latestFrameJobs.get(frameJobKey(target.shotIndex, target.frameNumber))
        // 只有真正点开看过的才算看过：没点开的结果、失败，以及还在跑的那条，照样要在帧上冒出来。
        onClose(latest !== undefined && opened.has(latest.id) ? latest : undefined)
        requestAnimationFrame(() => {
          const trigger = session.trigger
          if (trigger?.isConnected) trigger.focus()
          // 从「有新结果」角标点开的，关掉时角标已经清掉，焦点退回这一帧的编辑入口。
          else
            window.document
              .querySelector<HTMLElement>(frameEditTriggerSelector(target.shotIndex))
              ?.focus()
        })
      }}
      onApply={(previousUrl, url) => {
        // 分镜页的帧总有图（currentUrl 不会是 null），替换与撤销两头都是地址。
        if (previousUrl === null || url === null) throw new Error('分镜页的帧不能没有图')
        return onApply(previousUrl, url)
      }}
    />
  )
}
