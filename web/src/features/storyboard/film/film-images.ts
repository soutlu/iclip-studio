/** 制作页上的图：每张图最近一次按描述生成的任务，以及换图的流程。
 *
 * 换图的入口有三个，走同一条路：舞台上「替换」选文件、把图拖到舞台上、点过舞台后粘贴。一次只换一张，
 * 传好就把这张图换成它；换的是发起时的那张图，换段、换组都不影响。没图的那张也能这样换。 */

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

/** 一张图最近一次按描述生成的任务；帧图编辑有底图，不算。没图时生成卡看它。 */
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

/** 一张图最新的那条图片任务，按描述生成与帧图编辑都算；有图时舞台上的角标看它。 */
export const latestNodeImageJob = (
  jobs: readonly GenerationJob[],
  node: string,
): GenerationJob | undefined =>
  jobs.filter((job) => job.metadata?.['film_node'] === node).toSorted(newestFirst)[0]

type ReplaceOptions = {
  /** 舞台上的那张图；选中的段没挂图时为 undefined，无可换。 */
  frame: FilmFrame | undefined
  disabled: boolean
  /** 新图已传好：把 `frame` 换成 `url`；失败抛出给人看的原因。 */
  onReplace: (frame: FilmFrame, url: string) => Promise<void>
}

export const useFilmReplace = ({ disabled, frame, onReplace }: ReplaceOptions) => {
  // 正在换的那张图；换完之前不收下一张。
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
    if (files.length !== 1 || file === undefined) toast.error('每次只能替换一张图片')
    else void replace(file)
  }

  const drop = useFileDropTarget({
    blocked,
    onDirectory: () => toast.error('不支持文件夹，请拖入一张图片文件'),
    onFiles: take,
  })

  /** 舞台上的粘贴：剪贴板里有图才接，文字照常交给别处。 */
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (files.length === 0 || blocked) return
    event.preventDefault()
    take(files)
  }

  return {
    drop,
    onPaste,
    /** 选文件换图；只读、正在换或没有图时不做。 */
    replace,
    /** 舞台上那张图正在换。 */
    uploading: pending !== null && pending === frame?.node,
    /** 有图正在换，出片要等它。 */
    busy: pending !== null,
  }
}

/** 这张图的生图描述摊成输入卡的样子：文字照旧，参考图是图片 chip，名字用图的名字。 */
export const promptParts = (frame: FilmFrame): EditDraftPart[] =>
  (frame.prompt ?? []).map((run) =>
    run.kind === 'image'
      ? { kind: 'image', name: run.label, url: run.url }
      : { kind: 'text', text: run.text },
  )

/** 再生成这次用的描述：和文件里的一样就不给（后端照文件拼），改过的只用这一次、不写回文件。 */
export const regeneratePrompt = (
  original: readonly EditDraftPart[],
  edited: readonly EditDraftPart[],
): { text: string; referenceImageUrls: string[] } | undefined => {
  const mine = compileReferencePrompt(edited)
  return JSON.stringify(mine) === JSON.stringify(compileReferencePrompt(original))
    ? undefined
    : mine
}
