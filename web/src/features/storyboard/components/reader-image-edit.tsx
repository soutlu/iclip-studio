import { frameJobKey } from '../frame-status'
import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { StoryboardFrameTarget } from '../image-edit/image-edit-types'
import type { GenerationJob } from '../storyboard.api'
import { frameEditTriggerSelector } from './frame-edit-trigger'

export type FrameEditSession = {
  target: StoryboardFrameTarget
  initialKey?: string | undefined
  trigger: HTMLElement | null
}

type Props = {
  session: FrameEditSession
  frames: readonly string[]
  aspectRatio: string
  latestFrameJobs: ReadonlyMap<string, GenerationJob>
  onClose: (seen: GenerationJob | undefined) => void
  onApply: (previousUrl: string, url: string) => Promise<void>
}

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
      currentUrl={frames[target.frameNumber - 1]}
      subtitle={`镜头组 ${target.shotIndex} · 帧 @${target.frameNumber}`}
      frames={frames.map((url, index) => ({ name: `帧 @${index + 1}`, url }))}
      aspectRatio={aspectRatio}
      initialKey={session.initialKey}
      onClose={(opened) => {
        const latest = latestFrameJobs.get(frameJobKey(target.shotIndex, target.frameNumber))
        onClose(latest !== undefined && opened.has(latest.id) ? latest : undefined)
        requestAnimationFrame(() => {
          const trigger = session.trigger
          if (trigger?.isConnected) trigger.focus()
          else
            window.document
              .querySelector<HTMLElement>(frameEditTriggerSelector(target.shotIndex))
              ?.focus()
        })
      }}
      onApply={(previousUrl, url) => {
        if (previousUrl === null || url === null) throw new Error('分镜页的帧不能没有图')
        return onApply(previousUrl, url)
      }}
    />
  )
}
