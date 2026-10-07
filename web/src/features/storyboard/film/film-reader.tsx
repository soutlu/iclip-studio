/** 制作页的组合根：读 AI 导演的工程、草稿与路由参数在这里，分给顶栏、舞台、文案列与灯箱。
 *
 * 路由参数沿用分镜页的：`shot` 是第几组，`content` 是选中的段，`frame` 是舞台上那张图在这组 `frames` 里的位置。
 * 两个文件检查出问题时整页只写问题数，等 AI 导演改好。 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { ReaderNotice, SaveStatus } from '../components/draft-status'
import { StoryboardToolbar } from '../components/storyboard-toolbar'
import { useLiveGenerations } from '../use-live-generations'
import { useShotArrowKeys } from '../use-shot-arrow-keys'
import { useFilmFileChanges, useFilmView } from './film.api'
import {
  contentOfFrame,
  filmGroupSummary,
  filmGroupText,
  resolveFilmSelection,
  segmentFrames,
} from './film-content'
import { FilmScript } from './film-script'
import { FilmStage } from './film-stage'
import { useFilmDraft, type FilmSaveState } from './use-film-draft'

type ReaderSearch = {
  content?: string | undefined
  frame?: number | undefined
  shot?: number | undefined
}

export function FilmReader(props: ArtifactRendererProps) {
  return <FilmWorkspace key={props.conversationId} {...props} />
}

function FilmWorkspace({ conversationId, readOnly }: ArtifactRendererProps) {
  const film = useFilmView(conversationId)
  useFilmFileChanges(conversationId)
  useLiveGenerations(conversationId)
  const draft = useFilmDraft(conversationId, film.data)
  const navigate = useNavigate()
  const search: ReaderSearch = useSearch({ strict: false })
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [media, setMedia] = useState<LightboxMedia | null>(null)
  const view = draft.view
  const groups = view?.groups ?? []
  const position =
    search.shot !== undefined && search.shot >= 1 && search.shot <= groups.length ? search.shot : 1

  const go = (next: ReaderSearch) => {
    const cleared =
      next.shot !== undefined && next.shot !== position
        ? { content: undefined, frame: undefined }
        : {}
    void navigate({
      replace: true,
      search: (previous: ReaderSearch) => ({ ...previous, ...cleared, ...next }),
      to: '.',
    })
  }
  const goShot = (next: number) => go({ shot: next })
  useShotArrowKeys(root, { onGo: goShot, position, total: groups.length })

  if (view === undefined) {
    return (
      <ReaderNotice
        text={film.isError ? errorMessageOf(film.error, '读取分镜失败') : '正在读取分镜…'}
      />
    )
  }
  if (view.problems > 0) return <FilmProblems count={view.problems} />
  const group = groups[position - 1]
  const selection =
    group === undefined
      ? undefined
      : resolveFilmSelection(group, { content: search.content, frame: search.frame })
  if (group === undefined || selection === undefined)
    return <ReaderNotice text="分镜里还没有镜头组" />

  // 选段不指定图时：选的还是这段就停在当前图，换了段就到它挂的第一张。
  const select = (content: string, frame?: number) =>
    go({
      content,
      frame:
        frame ??
        (content === selection.contentId ? selection.frame : segmentFrames(group, content)[0]),
    })

  return (
    <>
      <div className="storyboard-workbench" ref={setRoot}>
        <StoryboardToolbar
          copy={{ done: '已复制这组的字', label: '复制这组的字', text: filmGroupText(group) }}
          groups={groups.map(filmGroupSummary)}
          onGoShot={goShot}
          position={position}
          status={
            <SaveStatus
              hasUnsavedChanges={draft.hasUnsavedChanges}
              onRetry={() => void draft.saveNow()}
              state={draft.state}
            />
          }
        />
        <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
          {/* 可聚焦，点舞台空白处也算焦点在工作台里，↑↓ 切组才收得到。 */}
          <section
            aria-label={`镜头组 ${group.index}`}
            className="storyboard-body"
            // 换组整块重挂：编辑器、箭头与滚动位置都属于原来那组。
            key={group.index}
            tabIndex={-1}
          >
            <FilmStage
              frame={selection.frame}
              group={group}
              onOpen={(frame) => setMedia({ kind: 'image', name: frame.label, url: frame.url })}
              onStep={(frame) =>
                go({ content: contentOfFrame(group, selection.contentId, frame), frame })
              }
            />
            <div aria-hidden className="storyboard-divider" />
            <div className="storyboard-script">
              <FilmScript
                frame={selection.frame}
                group={group}
                onEdit={draft.update}
                onSelect={select}
                readOnly={readOnly}
                selectedId={selection.contentId}
              />
            </div>
          </section>
        </div>
      </div>
      <MediaLightbox media={media} onClose={() => setMedia(null)} />
      <FilmConflictDialog resolve={draft.resolveConflict} state={draft.state} />
    </>
  )
}

/** 两个文件检查出问题：只写有几处，改法交给 AI 导演。 */
function FilmProblems({ count }: { count: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-body font-semibold text-on-surface">分镜有 {count} 处要 AI 导演改一下</p>
      <p className="text-body-sm text-on-surface-variant">
        在对话里让它检查一下分镜，改好了这里就能用
      </p>
    </div>
  )
}

/** 写回时撞上别人的改动，且改的是同一段：留我的还是用最新的。新版本里已经没有的段只能用最新的。 */
function FilmConflictDialog({
  resolve,
  state,
}: {
  resolve: (choice: 'mine' | 'theirs') => void
  state: FilmSaveState
}) {
  const conflicts = state.kind === 'conflict' ? state.conflicts : []
  const gone = conflicts.filter((conflict) => conflict.theirs === undefined)
  const names = (items: typeof conflicts) => items.map((conflict) => conflict.label).join('、')
  const note =
    gone.length === 0
      ? '选择留你的修改，或用最新的；没冲突的修改会保留。'
      : gone.length === conflicts.length
        ? '这几段在最新的分镜里已经没有了，只能用最新的。'
        : `${names(gone)}在最新的分镜里已经没有了，留你的只留还在的几段。`
  return (
    <DialogRoot
      onOpenChange={(open) => !open && resolve('theirs')}
      open={state.kind === 'conflict'}
    >
      <DialogSurface aria-label="分镜有别的改动">
        <DialogHeader closeLabel="关闭（用最新的）" title="分镜有别的改动">
          {names(conflicts)}在你编辑时被改了。
        </DialogHeader>
        <DialogBody>
          <p className="text-body text-on-surface">{note}</p>
        </DialogBody>
        <DialogFooter>
          <span />
          <span className="flex gap-2">
            <Button onClick={() => resolve('theirs')} size="md" variant="ghost">
              用最新的
            </Button>
            <Button
              disabled={gone.length === conflicts.length}
              onClick={() => resolve('mine')}
              size="md"
            >
              留我的
            </Button>
          </span>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
