import { useCallback } from 'react'
import { HF_AUDIO_AUTOMATION_ATTR } from '@hyperframes/core/audio-automation'
import { errorMessageOf } from '@/shared/api/client'
import { splitOwners } from './caption-edit'
import { rippleStarts, withLinkedStarts, type Cut, type Timing } from './clip-edit'
import { CAPTION_OWNER } from './composition/captions'
import type { CatalogItem, ComponentCatalog, VariableValue } from './composition/catalog'
import { audioElement, hostElement, videoElement, type Canvas } from './composition/film'
import { mainOf, sceneOf, tablesOf } from './film-files'
import {
  allClipsOf,
  bindingsOf,
  canvasOf,
  captionsById,
  captionsHostOf,
  clipsOf,
  fileOf,
  rootOf,
} from './film-view'
import {
  followingByDefault,
  followLocale,
  keepingLinks,
  newClipId,
  pinField,
  removeCaption,
  resizeCanvas,
  setOwnTiming,
} from './film-writes'
import { copyItemFiles } from './final-cut.api'
import { itemDurationMs } from './items'
import { translationOf } from './locales'
import { onRow, topTrack, type Landing, type Renumbering } from './placement'
import { automationHalves, HalfRejected, SPLIT_FAILED_TEXT, splitHalves } from './split-halves'
import { newClipZ, restackedZ } from './stacking'
import type { ProjectSession } from './use-film-project'
import type { NewAudio, NewVideo } from './use-film-session'
import type { StackingDirection } from './vendor/hyperframes-studio/player/components/timelineStackingSync'

const NO_RENUMBERING: Renumbering = new Map()
const NO_STARTS: ReadonlyMap<string, number> = new Map()

/**
 * 时间线上的片段编辑（见 `useFilmSession`）：放进视频、元素或模板、音频，改起止、换行、挪动、隐藏、删掉和切开，
 * 每次都算一步撤销。
 */
export function useClipEdits(
  conversationId: string,
  catalog: ComponentCatalog,
  { projectRef, noticeRef, perform, edit, show }: ProjectSession,
) {
  /**
   * 将多段视频素材首尾相接加入画面区：传入 `at` 时从指定轨道与时刻起排（由调用方保证区间空闲），
   * 否则追加至主轨（画面区首行）末尾；`renumber` 用于新建轨道行时重排其余片段行号。
   * 新片段默认置顶并插至根节点首位；传入 `canvas` 时在同一批次同步调整画布尺寸（仅改画布本身，见 `resizeCanvas`），
   * 撤销时片段与画布尺寸一并回退。工程尚未就绪时忽略操作。
   */
  const addVideos = useCallback(
    (
      videos: readonly NewVideo[],
      at?: Landing,
      renumber: Renumbering = NO_RENUMBERING,
      canvas?: Canvas,
    ): boolean => {
      const project = projectRef.current
      if (project === null) return false
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return false
      const existing = clipsOf(engine, catalog)
      // 别的片段先换成新的行号，后面都按换完的样子算
      const others = existing.map((clip) => ({
        ...clip,
        track: renumber.get(clip.id) ?? clip.track,
      }))
      const track = at?.track ?? topTrack(others)
      const row = others.filter((clip) => onRow(clip, { zone: 'visual', track }))
      let end = at?.start ?? Math.max(0, ...row.map((clip) => clip.start + clip.duration))
      perform(project, () => {
        if (canvas !== undefined) resizeCanvas(engine, sceneOf(project), canvas)
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        for (const [placed, video] of videos.entries()) {
          const element = videoElement({
            ...video,
            id: newClipId(),
            start: end,
            track,
            volume: 1,
            playbackRate: 1,
            fadeIn: 0,
            fadeOut: 0,
            z: newClipZ(existing, placed),
            hidden: false,
            link: null,
            syncOrigin: null,
            audioGroup: null,
            fxCarve: null,
            fxChain: null,
            automation: null,
          })
          engine.addElement(root.id, 0, element)
          end += video.duration
        }
      })
      show()
      return true
    },
    [catalog, perform, show, projectRef],
  )

  /**
   * 将组件库条目加入工程：先将条目依赖文件拷贝至工程目录，再按 `at` 指定轨道与时刻创建宿主元素（调用方保证区间空闲），
   * 可填项取值取 `values`、时长取条目默认时长、尺寸匹配当前画布。若工程已启用多语言，文字字段默认跟随语言（见 `followingByDefault`）；
   * `renumber` 用法同 `addVideos`。宿主置顶并插至根节点首位；依赖文件拷贝失败时提示错误，工程尚未就绪或拷贝失败时均不修改工程。
   */
  const addItem = useCallback(
    async (
      item: CatalogItem,
      values: Readonly<Record<string, VariableValue>>,
      at: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      try {
        await copyItemFiles(conversationId, catalog, item)
      } catch (error) {
        noticeRef.current(errorMessageOf(error, '元素和模板读取失败'))
        return false
      }
      const project = projectRef.current
      if (project === null) return false
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return false
      const existing = clipsOf(engine, catalog)
      const duration = itemDurationMs(item, existing)
      const size = canvasOf(engine)
      const id = newClipId()
      perform(project, () => {
        for (const [other, next] of renumber) engine.setTiming(other, { trackIndex: next })
        const element = hostElement(
          {
            id,
            label: item.title,
            item: item.name,
            src: item.src,
            start: at.start,
            duration,
            playbackStart: 0,
            track: at.track,
            values: { ...values },
            z: newClipZ(existing, 0),
            hidden: false,
            link: null,
          },
          item,
          size,
          catalog,
        )
        engine.addElement(root.id, 0, element)
        if (tablesOf(project).size > 0)
          for (const field of followingByDefault(engine, { id }, item))
            followLocale(engine, { id, values }, field)
      })
      show()
      return true
    },
    [catalog, conversationId, perform, show, noticeRef, projectRef],
  )

  /**
   * 将单段音频加入声音区：自 `at` 指定轨道与时刻起排（调用方保证区间空闲），插至根节点首位且不写 `z-index`。
   * `renumber` 用法同 `addVideos`。工程尚未就绪时忽略操作。
   */
  const addAudio = useCallback(
    (audio: NewAudio, at: Landing, renumber: Renumbering = NO_RENUMBERING): boolean => {
      const project = projectRef.current
      if (project === null) return false
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return false
      perform(project, () => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        const element = audioElement({
          ...audio,
          id: newClipId(),
          start: at.start,
          track: at.track,
          volume: 1,
          playbackRate: 1,
          fadeIn: 0,
          fadeOut: 0,
          loop: false,
          hidden: false,
          link: null,
          syncOrigin: null,
          dub: null,
          audioGroup: null,
          fxCarve: null,
          fxChain: null,
          automation: null,
        })
        engine.addElement(root.id, 0, element)
      })
      show()
      return true
    },
    [perform, show, projectRef],
  )

  /**
   * 改几个片段各自的起止和入点，一起算一步撤销。组件或块的片段的入点写成从第几秒开始播，是 0 时去掉
   * 这个属性；「其他」片段和字幕没有入点，只改起止（字幕改在字幕场景里）。联动的伙伴要跟着动时由调用方
   * 算进 `timings`。
   */
  const retime = useCallback(
    (timings: ReadonlyMap<string, Timing>) => {
      edit((engine, scene) => {
        const kinds = new Map(clipsOf(engine, catalog).map((clip) => [clip.id, clip.kind]))
        const captions = captionsById(engine, scene)
        keepingLinks(engine, () => {
          for (const [id, timing] of timings) {
            const span = { start: timing.start / 1000, duration: timing.duration / 1000 }
            setOwnTiming(fileOf(engine, scene, captions, id), id, span)
            const kind = kinds.get(id)
            const inPoint = String(timing.mediaStart / 1000)
            if (kind === 'host')
              engine.setAttribute(id, 'data-playback-start', timing.mediaStart > 0 ? inPoint : null)
            else if (kind === 'video' || kind === 'audio')
              engine.setAttribute(id, 'data-media-start', inPoint)
          }
        })
      })
    },
    [catalog, edit],
  )

  /**
   * 把一个片段换到另一行的某个时间。`direction` 是它往上还是往下挪（null 时不调叠放顺序）：
   * 只重排它自己，别的片段的叠放顺序和文件里的先后都不动。
   * `renumber` 是为它新开一行时别的片段要换成的行号；`starts` 是和它一起挪的片段（含联动的伙伴，字幕改在字幕
   * 场景里）各自的新起点，它们留在原来的行。都和它算一步撤销。
   */
  const moveClip = useCallback(
    (
      id: string,
      at: Landing,
      direction: StackingDirection | null,
      renumber: Renumbering = NO_RENUMBERING,
      starts: ReadonlyMap<string, number> = NO_STARTS,
    ) => {
      edit((engine, scene) => {
        const captions = captionsById(engine, scene)
        for (const [other, next] of renumber) engine.setTiming(other, { trackIndex: next })
        keepingLinks(engine, () => {
          for (const [other, start] of starts)
            setOwnTiming(fileOf(engine, scene, captions, other), other, { start: start / 1000 })
          setOwnTiming(engine, id, { start: at.start / 1000, trackIndex: at.track })
        })
        if (direction === null) return
        // 按挪完的样子算：一起挪的片段的新起点、别的片段的新行号都已写进去
        const z = restackedZ(clipsOf(engine, catalog), id, direction)
        if (z !== undefined) engine.setStyle(id, { zIndex: z > 0 ? String(z) : null })
      })
    },
    [catalog, edit],
  )

  /** 把几个片段各自挪到新的起点（合拢空档），联动的伙伴挪同样的时间差，一起算一步撤销。 */
  const restart = useCallback(
    (starts: ReadonlyMap<string, number>) => {
      edit((engine) => {
        const all = withLinkedStarts(starts, clipsOf(engine, catalog))
        keepingLinks(engine, () => {
          for (const [id, start] of all) setOwnTiming(engine, id, { start: start / 1000 })
        })
      })
    },
    [catalog, edit],
  )

  /**
   * 把几个片段一起隐藏或显示回来，算一步撤销。字幕不能单句隐藏：给到字幕时隐藏、显示的是主文件里的字幕宿主，
   * 所有字幕一起。
   */
  const setHidden = useCallback(
    (ids: readonly string[], hidden: boolean) => {
      edit((engine, scene) => {
        const captions = captionsById(engine, scene)
        const host = captionsHostOf(engine)?.id
        const targets = new Set(ids.map((id) => (captions.has(id) ? host : id)))
        for (const id of targets)
          if (id !== undefined) engine.setAttribute(id, 'data-hidden', hidden ? '' : null)
      })
    },
    [edit],
  )

  /**
   * 删掉几个片段；`ripple` 为真时主轨里后面的片段往前补上，联动的伙伴挪同样的时间差。删一句字幕是删掉
   * 场景里它的元素、主文件根上它的变量和各语言值表里它的值；删掉最后一句时场景文件和宿主都留着。
   * 删组件或块的片段时它随语言的字段的根变量和各语言值表里的值一起删掉。答复删了没有（见 `edit`）。
   */
  const removeClips = useCallback(
    (ids: readonly string[], ripple: boolean) =>
      edit((engine, scene, tables) => {
        const before = clipsOf(engine, catalog)
        const captions = captionsById(engine, scene)
        const gone = new Set(ids)
        const starts = ripple ? withLinkedStarts(rippleStarts(before, gone), before) : NO_STARTS
        for (const id of gone) {
          const caption = captions.get(id)
          if (scene !== undefined && caption !== undefined) {
            removeCaption(engine, scene, tables.values(), caption)
            continue
          }
          for (const fieldId of Object.keys(bindingsOf(engine, id)))
            pinField(engine, tables.values(), id, fieldId)
          engine.removeElement(id)
        }
        keepingLinks(engine, () => {
          for (const [id, start] of starts)
            if (!gone.has(id)) setOwnTiming(engine, id, { start: start / 1000 })
        })
      }),
    [catalog, edit],
  )

  /**
   * 切开几个片段（`cuts` 由 `clip-edit.ts` 里的切开函数算好），算一步撤销：前半段还是原来的片段、只改时长，
   * 后半段是它的整份复制、紧跟在它后面，随语言的字段的根变量连同各语言的值复制一份给它；切的是视频片段时，
   * 从切点起的字幕改成属于后半段（见 `splitOwners`）；片段上的音频曲线在切点分成两半（见 `splitAutomation`）。
   * 有一个后半段写不进去（比如元素里带着脚本）时都不切，提示原因。
   */
  const split = useCallback(
    (cuts: readonly Cut[]) => {
      const project = projectRef.current
      if (project === null || cuts.length === 0) return
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return
      const halves = splitHalves(engine, cuts, clipsOf(engine, catalog))
      if (halves === null) return
      const owners = splitOwners(
        allClipsOf(engine, sceneOf(project), catalog),
        cuts,
        new Map(halves.map((half) => [half.of, half.id])),
      )
      try {
        edit((current, scene, tables) => {
          for (const half of halves)
            if (current.addElement(root.id, half.index, half.html) !== half.id)
              throw new HalfRejected()
          for (const [from, to] of halves.flatMap((half) => half.variables)) {
            const declaration = current.getVariableDeclarations().find((each) => each.id === from)
            if (declaration !== undefined) current.declareVariable({ ...declaration, id: to })
            for (const table of tables.values()) {
              const value = translationOf(table.values(), from)
              if (value !== null) table.set(to, value)
            }
          }
          // 链接的片段切在同一处：SDK 把时长带给结尾对齐的链接片段时，带过去的也正好是切点
          for (const cut of cuts) current.setTiming(cut.id, { duration: cut.first.duration / 1000 })
          for (const cut of cuts) {
            const attributes = current.getElement(cut.id)?.attributes ?? {}
            const lanes = automationHalves((name) => attributes[name], cut)
            if (lanes !== null) current.setAttribute(cut.id, HF_AUDIO_AUTOMATION_ATTR, lanes.first)
          }
          for (const [id, owner] of owners) scene?.setAttribute(id, CAPTION_OWNER, owner)
        })
      } catch (error) {
        // 一批操作里抛出时引擎已经整批退回
        if (!(error instanceof HalfRejected)) throw error
        noticeRef.current(SPLIT_FAILED_TEXT)
      }
    },
    [catalog, edit, noticeRef, projectRef],
  )

  return { addVideos, addItem, addAudio, retime, moveClip, restart, setHidden, removeClips, split }
}
