import { useState, type ClipboardEvent } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { toast } from '@/shared/ui/toast'
import { compileReferencePrompt } from '../edit-prompt'
import type { EditDraftPart } from '../image-edit/image-edit-types'
import type { GenerationJob } from '../storyboard.api'
import type { FilmFrame } from './film.api'

const newestFirst = (a: GenerationJob, b: GenerationJob) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt)

export const latestNodeJob = (
  jobs: readonly GenerationJob[],
  node: string,
): GenerationJob | undefined =>
  jobs
    .filter(
      (job) =>
        job.metadata?.['film_node'] === node && job.sourceJobId == null && job.sourceUrl == null,
    )
    .toSorted(newestFirst)[0]

export const latestNodeImageJob = (
  jobs: readonly GenerationJob[],
  node: string,
): GenerationJob | undefined =>
  jobs.filter((job) => job.metadata?.['film_node'] === node).toSorted(newestFirst)[0]

type ReplaceOptions = {
  frame: FilmFrame | undefined
  disabled: boolean
  onReplace: (frame: FilmFrame, url: string) => Promise<void>
}

export const useFilmReplace = ({ disabled, frame, onReplace }: ReplaceOptions) => {
  const [pending, setPending] = useState<string | null>(null)
  const blocked = disabled || pending !== null || frame === undefined

  const replace = async (file: File) => {
    if (blocked || frame === undefined) return
    const target = frame
    setPending(target.node)
    try {
      await onReplace(target, (await uploadMediaFile(file, 'image')).url)
      toast(`已替换${target.label}`)
    } catch (error) {
      toast.error(errorMessageOf(error, '替换图片失败'))
    } finally {
      setPending(null)
    }
  }
  const take = (files: readonly File[]) => {
    const [file] = files
    if (files.length !== 1 || file === undefined)
      toast.error('已选择多个文件，无法替换；请仅选择一张图片')
    else void replace(file)
  }

  const drop = useFileDropTarget({
    blocked,
    onDirectory: () => toast.error('无法用文件夹替换图片；请拖入一张图片文件'),
    onFiles: take,
  })

  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (files.length === 0 || blocked) return
    event.preventDefault()
    take(files)
  }

  return {
    drop,
    onPaste,
    replace,
    uploading: pending !== null && pending === frame?.node,
    busy: pending !== null,
  }
}

export const promptParts = (frame: FilmFrame): EditDraftPart[] =>
  (frame.prompt ?? []).map((run) =>
    run.kind !== 'image'
      ? { kind: 'text', text: run.text }
      : run.url === null
        ? { kind: 'text', text: run.label }
        : { kind: 'image', name: run.label, url: run.url },
  )

export const regeneratePrompt = (
  original: readonly EditDraftPart[],
  edited: readonly EditDraftPart[],
): { text: string; referenceImageUrls: string[] } | undefined => {
  const mine = compileReferencePrompt(edited)
  return JSON.stringify(mine) === JSON.stringify(compileReferencePrompt(original))
    ? undefined
    : mine
}
