/** 制作页上挂分镜页的图片编辑器：开在工程里的一张图上，版本条列这张图的全部生成与编辑（`film_node`），
 * 选中一版点「选用这张」就是选用它，撤销回到上一个选用（或回到没有图），用到它的地方一起换。没选用的生成图
 * 也能打开，这时没有「在用」那一格。按描述生成的图版本条末尾有「再生成」：输入卡装着这张图的描述，改过的只用
 * 这一次。关掉后焦点回到点开它的地方。 */

import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { GenerationJob } from '../storyboard.api'
import type { FilmGroup } from './film.api'
import { promptParts, regeneratePrompt } from './film-images'

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
  /** 把这张图从 `previousUrl` 换成 `url`；这张图已经不是 `previousUrl` 时拒绝。null 是没有选用。 */
  onApply: (previousUrl: string | null, url: string | null) => Promise<void>
  /** 按描述再生成一张；`prompt` 是改过的描述，没改过不给。失败抛出给人看的原因。 */
  onRegenerate: (
    prompt: { text: string; referenceImageUrls: string[] } | undefined,
  ) => Promise<void>
}

export function FilmImageEdit({
  conversationId,
  group,
  latestJob,
  onApply,
  onClose,
  onRegenerate,
  session,
}: FilmImageEditProps) {
  const frame = group.frames.find((item) => item.node === session.node)
  // 输入卡里按 @N 插图：下标加一要等于编号，只放有编号的；菜单与芯片上叫图的名字。
  const numbered = group.frames
    .flatMap(({ label, number, url }) =>
      number === null || url === null ? [] : [{ name: label, number, url }],
    )
    .toSorted((a, b) => a.number - b.number)
    .map(({ name, url }) => ({ name, url }))
  // 只有按描述生成的图能再生成；用户给的图只能换。
  const original = frame?.kind === 'generated' && frame.prompt !== null ? promptParts(frame) : null
  return (
    <FrameImageEditor
      aspectRatio={frame?.aspectRatio ?? group.aspectRatio}
      currentUrl={frame === undefined ? undefined : frame.url}
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
      regenerate={
        original === null
          ? undefined
          : {
              parts: original,
              submit: (parts) => onRegenerate(regeneratePrompt(original, parts)),
            }
      }
      subtitle={frame?.label ?? ''}
      target={{ conversationId, node: session.node }}
    />
  )
}
