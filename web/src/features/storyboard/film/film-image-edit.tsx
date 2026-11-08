import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { GenerationJob } from '../storyboard.api'
import type { FilmGroup } from './film.api'
import { missingReferencesText } from './film-content'
import { promptParts, regeneratePrompt } from './film-images'

export type FilmEditSession = {
  node: string
  initialKey?: string | undefined
  trigger: HTMLElement | null
}

export const FILM_EDIT_TRIGGER = 'data-film-edit'

type FilmImageEditProps = {
  conversationId: string
  session: FilmEditSession
  group: FilmGroup
  latestJob: GenerationJob | undefined
  onClose: (seen: GenerationJob | undefined) => void
  onApply: (previousUrl: string | null, url: string | null) => Promise<void>
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
  const listed =
    frame?.prompt != null
      ? frame.prompt.flatMap((run) =>
          run.kind === 'image' ? [{ label: run.label, number: run.number, url: run.url }] : [],
        )
      : group.frames
  const numbered = [
    ...new Map(
      listed.flatMap(({ label, number, url }) =>
        number === null || url === null ? [] : [[number, { name: label, number, url }] as const],
      ),
    ).values(),
  ].toSorted((a, b) => a.number - b.number)
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
              blocked: missingReferencesText(frame?.missing ?? []),
              parts: original,
              submit: (parts) => onRegenerate(regeneratePrompt(original, parts)),
            }
      }
      subtitle={frame?.label ?? ''}
      target={{ conversationId, node: session.node }}
    />
  )
}
