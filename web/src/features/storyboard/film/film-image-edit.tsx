/** 制作页上挂分镜页的图片编辑器：开在工程里的一张图上，版本条列这张图的全部生成与编辑（`film_node`），
 * 「替换这张图」与撤销都是给这张图换地址，用到它的地方一起换。关掉后焦点回到点开它的地方。 */

import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { GenerationJob } from '../storyboard.api'
import type { FilmGroup } from './film.api'

/** 打开编辑器的这一次：哪张图、先选中哪条结果、从哪个控件点开。 */
export type FilmEditSession = {
  node: string
  initialKey?: string | undefined
  trigger: HTMLElement | null
}

/** 舞台上「编辑」的标记：点开它的角标关窗时可能已经不在，焦点退到这里。 */
export const FILM_EDIT_TRIGGER = 'data-film-edit'

type FilmImageEditProps = {
  conversationId: string
  session: FilmEditSession
  /** 正在看的这一组：编号、输入卡里能插的图都按它。 */
  group: FilmGroup
  /** 这张图最新的那条图片任务；关掉时它若点开看过，交回去标成看过。 */
  latestJob: GenerationJob | undefined
  onClose: (seen: GenerationJob | undefined) => void
  /** 把这张图从 `previousUrl` 换成 `url`；这张图已经不是 `previousUrl` 时拒绝。 */
  onApply: (previousUrl: string, url: string) => Promise<void>
}

export function FilmImageEdit({
  conversationId,
  group,
  latestJob,
  onApply,
  onClose,
  session,
}: FilmImageEditProps) {
  const frame = group.frames.find((item) => item.node === session.node)
  // 输入卡里按 @N 插图：下标加一要等于编号，只放有编号的。
  const numbered = group.frames
    .flatMap((item) => (item.number === null || item.url === null ? [] : [item]))
    .toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .map((item) => item.url ?? '')
  return (
    <FrameImageEditor
      aspectRatio={frame?.aspectRatio ?? group.aspectRatio}
      currentUrl={frame?.url ?? undefined}
      frames={numbered}
      initialKey={session.initialKey}
      key={session.node}
      onApply={onApply}
      onClose={(opened) => {
        onClose(latestJob !== undefined && opened.has(latestJob.id) ? latestJob : undefined)
        requestAnimationFrame(() => {
          const trigger = session.trigger
          if (trigger?.isConnected) trigger.focus()
          else window.document.querySelector<HTMLElement>(`[${FILM_EDIT_TRIGGER}]`)?.focus()
        })
      }}
      subtitle={frame?.label ?? ''}
      target={{ conversationId, node: session.node }}
    />
  )
}
