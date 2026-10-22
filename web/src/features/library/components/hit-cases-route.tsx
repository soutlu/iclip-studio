/** 资料库「爆款素材库」页签：从成片素材里挑进来的素材片，按作者、入库时间和标签筛选；卡片同成片素材，另带打标状态。
 * 点开用成片素材的查看器，定位到这条素材片所在的卡与那一版；上一条、下一条在爆款列表里走。
 * 治理者在筛选条最右多一个「管理标签」开关，打开后管理面板替换卡片列表。 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { ListEmpty, ListError } from '@/shared/ui/list-state'
import {
  isDefaultHitCaseScope,
  useHitCaseAuthorSource,
  useHitCases,
  type HitCase,
  type HitCaseScope,
} from '../hit-cases.api'
import { cardHeightFor } from '../library-layout'
import { useLibraryTagScope } from '../library-tag-scope'
import { useLibraryTags } from '../library-tags.api'
import { isTaggingBusy } from '../references.api'
import { isTagTreePrototype } from '../tag-tree-prototype'
import { focusCardOpener } from './card-focus'
import { LibraryCard } from './library-card'
import { LibraryList } from './library-list'
import { useLoadNextPageWhen } from './library-next-page'
import { LibraryPageHeader } from './library-page-header'
import { useLibraryPageScroll } from './library-page-scroll'
import { LibraryPageShell } from './library-page-shell'
import { LibraryTagAdmin } from './library-tag-admin'
import { LibraryViewer } from './library-viewer'
import { TaggedLibraryFilters } from './tagged-library-filters'

/** 打开的是哪一条：所在的卡与那一版。 */
export type HitCaseTarget = { cardId: string; jobId: string }

type HitCasesRouteProps = {
  tabs: ReactNode
  scope: HitCaseScope
  onScopeChange: (next: HitCaseScope) => void
  /** 地址里的卡与版本；卡为空即没打开查看器。 */
  cardId: string | null
  versionId: string | null
  onHitCaseChange: (target: HitCaseTarget | null, replace: boolean) => void
  shareLinkOf: (cardId: string, versionId: string | null) => string
}

export function HitCasesRoute({
  tabs,
  scope: requestedScope,
  onScopeChange,
  cardId,
  versionId,
  onHitCaseChange,
  shareLinkOf,
}: HitCasesRouteProps) {
  const { mainRef, getScrollElement } = useLibraryPageScroll()
  const tagTree = useLibraryTags()
  const tags = tagTree.data?.index
  const { data: user } = useUser()
  const canManageTags = hasPermission(user, PERMISSION.usersManage)
  const authors = useHitCaseAuthorSource()
  const [managingTags, setManagingTags] = useState(isTagTreePrototype)
  // 地址里的标签先对过标签树：树里没有的（如已被删掉）不带去查，免得整页 422；没选标签就不必等树。
  // 树读失败时也照原样去查，列表才有结果，好露出读标签失败的提示与重试。
  const scope = useLibraryTagScope(requestedScope, tags, onScopeChange)
  const hitCases = useHitCases(
    scope,
    tags !== undefined || requestedScope.tags.length === 0 || tagTree.isError,
  )
  const loaded = hitCases.data?.pages.flatMap((page) => page.items) ?? []
  const total = hitCases.data?.pages[0]?.total ?? undefined
  // 列表轮询里每有一条打完（还在打的变少），标签树重读一次，条数跟上。
  const busyCount = loaded.filter((item) => isTaggingBusy(item.tagStatus)).length
  const lastBusyCountRef = useRef(busyCount)
  const refetchTags = tagTree.refetch
  useEffect(() => {
    if (busyCount < lastBusyCountRef.current) void refetchTags()
    lastBusyCountRef.current = busyCount
  }, [busyCount, refetchTags])

  const filtered = !isDefaultHitCaseScope(scope)
  const counter = total === undefined ? undefined : filtered ? `找到 ${total} 条` : `共 ${total} 条`

  // 同一张卡可能有几版都在库里，上一条、下一条按版本走。
  const index = versionId === null ? -1 : loaded.findIndex((item) => item.jobId === versionId)
  const prevId = index > 0 ? (loaded[index - 1]?.jobId ?? null) : null
  const nextId = index >= 0 ? (loaded[index + 1]?.jobId ?? null) : null
  useLoadNextPageWhen(hitCases, index >= 0 && index === loaded.length - 1)

  // 从卡上的故事板点某一帧进来时，从那一刻开始播。
  const [startAt, setStartAt] = useState<{ jobId: string; at: number } | null>(null)
  const open = (item: HitCase, replace: boolean, at: number | null = null) => {
    setStartAt(at === null ? null : { at, jobId: item.jobId })
    onHitCaseChange({ cardId: item.cardId, jobId: item.jobId }, replace)
  }

  return (
    <LibraryPageShell
      attachments={
        cardId === null ? null : (
          <LibraryViewer
            listed={undefined}
            nextId={nextId}
            onClose={() => onHitCaseChange(null, true)}
            onNavigate={(jobId) => {
              const item = loaded.find((candidate) => candidate.jobId === jobId)
              if (item !== undefined) open(item, true)
            }}
            onRestoreFocus={() => focusCardOpener(mainRef.current, versionId ?? '')}
            prevId={prevId}
            shareLink={shareLinkOf(cardId, versionId)}
            startAt={startAt !== null && startAt.jobId === versionId ? startAt.at : null}
            versionId={versionId}
            videoId={cardId}
          />
        )
      }
      filters={
        canManageTags && managingTags && tags !== undefined ? null : (
          <TaggedLibraryFilters
            authors={authors}
            countKey="hitCases"
            manageTags={
              canManageTags
                ? { onToggle: () => setManagingTags((open) => !open), open: managingTags }
                : undefined
            }
            myUserName={user?.username ?? null}
            onChange={onScopeChange}
            scope={scope}
            tags={tags}
            trailing={counter}
          />
        )
      }
      header={
        <LibraryPageHeader
          {...(managingTags
            ? {}
            : {
                description:
                  '收录从成片素材中挑选的优秀视频及其标签。选择任一视频，可直接基于它再创作。',
              })}
          tabs={tabs}
        />
      }
      label="资料库"
      mainRef={mainRef}
    >
      {canManageTags && managingTags && tags !== undefined ? (
        <LibraryTagAdmin index={tags} onClose={() => setManagingTags(false)} />
      ) : (
        <LibraryList
          blocker={
            tags === undefined && tagTree.isError ? (
              <ListError
                message={errorMessageOf(tagTree.error, '读取标签失败')}
                onRetry={() => void tagTree.refetch()}
              />
            ) : undefined
          }
          empty={
            <ListEmpty>
              {filtered
                ? '暂无匹配的爆款素材，请更换或清除筛选'
                : '暂无爆款素材，请在「成片素材」中打开一条视频，在「爆款素材」页签点击「加入爆款素材库」'}
            </ListEmpty>
          }
          errorMessage="读取爆款素材失败"
          estimateHeight={cardHeightFor}
          getScrollElement={getScrollElement}
          items={loaded}
          keyOf={(item) => item.jobId}
          pending={tagTree.isPending}
          query={hitCases}
          renderItem={(item, width) => (
            <LibraryCard
              onOpen={(_id, at) => open(item, false, at)}
              status={
                item.tagStatus === 'failed' || isTaggingBusy(item.tagStatus) ? (
                  <TaggingBadge status={item.tagStatus} />
                ) : undefined
              }
              video={{
                face: item.face,
                id: item.jobId,
                take: item.take,
                title: item.title,
                userName: item.face.userName,
              }}
              width={width}
            />
          )}
          shown={loaded.length}
          skeletonLabel="正在读取爆款素材"
          total={total}
        />
      )}
    </LibraryPageShell>
  )
}

/** 画面左下角的打标状态：排队与打标中合成一种。 */
function TaggingBadge({ status }: { status: HitCase['tagStatus'] }) {
  if (status === 'failed')
    return (
      <span className="library-card-badge">
        <Icon decorative name="alert" size="xs" />
        打标失败
      </span>
    )
  return (
    <span className="library-card-badge">
      <Icon className="animate-spin" decorative name="spinner" size="xs" />
      正在打标
    </span>
  )
}
