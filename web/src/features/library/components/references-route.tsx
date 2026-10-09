/** 资料库「参考视频」页：页头与上传入口、吸顶筛选条、瀑布流与翻页，加上盖在列表上的详情。
 *
 * 整页都是拖放区，在页面上粘贴视频文件也能上传；读者不能上传（`canUpload` 为假）时这些入口都不出现。
 * 筛选范围与打开着的详情由路由存在查询参数里。 */

import { useCallback, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError, NextPageFooter } from '@/shared/ui/list-state'
import type { PickerSource } from '@/shared/ui/search-picker'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { referenceCardHeightFor } from '../library-layout'
import { videoTypeLabelsOf } from '../reference-labels'
import { useReferenceUpload, type PendingUpload } from '../reference-upload'
import {
  isBreakdownBusy,
  isDefaultReferenceScope,
  useReferenceFilters,
  useReferences,
  type ReferenceItem,
  type ReferenceScope,
} from '../references.api'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'
import { LibraryPageHeader } from './library-page-header'
import { ReferenceCard, UploadingCard } from './reference-card'
import { ReferenceFilters } from './reference-filters'
import { ReferenceViewer } from './reference-viewer'

type GridEntry =
  { kind: 'upload'; upload: PendingUpload } | { kind: 'reference'; item: ReferenceItem }

type ReferencesRouteProps = {
  /** 「成片｜参考视频」页签行，由路由给。 */
  tabs: ReactNode
  scope: ReferenceScope
  onScopeChange: (next: ReferenceScope) => void
  myUserName: string | null
  /** 打开着详情的那一条。 */
  referenceId: string | null
  /** 打开或关掉（null）详情；`replace` 为真时不新增历史记录。 */
  onReferenceChange: (id: string | null, replace: boolean) => void
}

export function ReferencesRoute({
  tabs,
  scope,
  onScopeChange,
  myUserName,
  referenceId,
  onReferenceChange,
}: ReferencesRouteProps) {
  const mainRef = useRef<HTMLElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const references = useReferences(scope)
  const loaded = references.data?.pages.flatMap((page) => page.items) ?? []
  const total = references.data?.pages[0]?.total ?? undefined
  const canUpload = references.data?.pages[0]?.canUpload ?? false
  const filters = useReferenceFilters(loaded.some((item) => isBreakdownBusy(item.breakdownStatus)))
  const labels = filters.data === undefined ? undefined : videoTypeLabelsOf(filters.data)
  const filtersError = filters.isError ? errorMessageOf(filters.error, '读取筛选项失败') : undefined
  // 按人筛选的候选：名下有参考视频的属主，候选 id 与显示名都是用户名。
  const owners: PickerSource = {
    error: filtersError,
    isPending: filters.isPending,
    onRetry: () => void filters.refetch(),
    options: (filters.data?.owners ?? []).map((owner) => ({
      id: owner.userName,
      label: owner.userName,
    })),
  }
  const upload = useReferenceUpload({
    enabled: canUpload,
    onOpenExisting: (id) => onReferenceChange(id, false),
  })

  const filtered = !isDefaultReferenceScope(scope)
  const counter = total === undefined ? undefined : filtered ? `找到 ${total} 条` : `共 ${total} 条`
  const pickFiles = () => fileInputRef.current?.click()
  const listed = referenceId === null ? undefined : loaded.find((item) => item.id === referenceId)

  const entries: GridEntry[] = [
    ...upload.pending.map((item) => ({ kind: 'upload' as const, upload: item })),
    ...loaded.map((item) => ({ item, kind: 'reference' as const })),
  ]

  // 关掉详情后焦点回到那张卡；卡已被虚拟列表回收就交给弹窗的默认去处。
  const focusCard = (id: string): boolean => {
    const button = mainRef.current?.querySelector<HTMLElement>(`[data-open-reference="${id}"]`)
    button?.focus()
    return button != null
  }
  const filterByAuthor = (userName: string) => onScopeChange({ ...scope, userName })

  // 名称表跟筛选项一起读，读回来之前列表先等着，不把片子类型的取值原文给人看。
  const listError = references.isError && !references.isFetchNextPageError
  const pending = references.isPending || (filters.isPending && !listError)

  let body: ReactNode
  if (pending) body = <LibraryGridSkeleton label="正在读取参考视频" />
  else if (listError)
    body = (
      <ListError
        message={errorMessageOf(references.error, '读取参考视频失败')}
        onRetry={() => void references.refetch()}
      />
    )
  else if (labels === undefined)
    body = (
      <ListError
        message={errorMessageOf(filters.error, '读取筛选项失败')}
        onRetry={() => void filters.refetch()}
      />
    )
  else if (entries.length === 0)
    body = filtered ? (
      <ListEmpty>暂无匹配的参考视频，请更换关键词或清除筛选</ListEmpty>
    ) : canUpload ? (
      <EmptyDropZone onPick={pickFiles} />
    ) : (
      <ListEmpty>暂无参考视频</ListEmpty>
    )
  else
    body = (
      <LibraryGrid
        estimateHeight={(_entry, width) => referenceCardHeightFor(width)}
        getScrollElement={getScrollElement}
        items={entries}
        keyOf={(entry) => (entry.kind === 'upload' ? entry.upload.key : entry.item.id)}
        renderItem={(entry, width) =>
          entry.kind === 'upload' ? (
            <UploadingCard myUserName={myUserName} upload={entry.upload} />
          ) : (
            <ReferenceCard
              item={entry.item}
              labels={labels}
              onAuthor={filterByAuthor}
              onOpen={(id) => onReferenceChange(id, false)}
              width={width}
            />
          )
        }
      />
    )

  return (
    <main
      aria-label="资料库"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={mainRef}
      {...upload.dragHandlers}
    >
      {/* 页头预留侧栏展开按钮的覆盖空间。 */}
      <div className="flex w-full flex-col px-4 pt-12 pb-10 sm:px-(--layout-list-page-gutter) sm:pt-14">
        <LibraryPageHeader
          action={canUpload ? <UploadButton onPick={pickFiles} /> : undefined}
          description="收录可供参考的视频及其拆解。选择任一视频，可参照其拍摄。"
          search={{
            label: '搜索拆解',
            onSearch: (q) => onScopeChange({ ...scope, q }),
            placeholder: '搜索拆解中的场景、动作、台词…',
            value: scope.q,
          }}
          tabs={tabs}
        />

        {/* 页内吸顶只需压住卡片；应用壳的侧栏抽屉在更高一层。 */}
        <div className="layer-content sticky top-0 -mx-1 bg-background px-1 py-3">
          <ReferenceFilters
            authors={owners}
            myUserName={myUserName}
            onChange={onScopeChange}
            options={{
              data: filters.data,
              error: filtersError,
              isPending: filters.isPending,
              onRetry: () => void filters.refetch(),
            }}
            scope={scope}
            trailing={counter}
          />
        </div>

        <div className="pt-3">
          {body}

          {/* 翻页失败只落在页脚，已读取的卡片照常显示。 */}
          {references.hasNextPage ? (
            references.isFetchNextPageError && !references.isFetchingNextPage ? (
              <ListError
                message={errorMessageOf(references.error, '读取参考视频失败')}
                onRetry={() => void references.fetchNextPage()}
              />
            ) : (
              <NextPageFooter
                getScrollElement={getScrollElement}
                query={references}
                shown={loaded.length}
                total={total}
              />
            )
          ) : null}
        </div>
      </div>

      {canUpload ? (
        <input
          accept={MEDIA_VIDEO_ACCEPT}
          aria-hidden
          className="hidden"
          multiple
          onChange={(event) => {
            upload.uploadVideos([...(event.currentTarget.files ?? [])])
            // 清空才能再选同一个文件。
            event.currentTarget.value = ''
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      ) : null}

      {/* 拖放提示与聊天输入框的整页拖放提示同一个样子。 */}
      {upload.dragOver
        ? createPortal(
            <div
              aria-hidden
              className="composer-drop-overlay layer-overlay animate-in duration-(--dur-s) fade-in"
              data-testid="reference-drop-overlay"
            >
              <div className="composer-drop-card">
                <Icon decorative name="add-file" size="lg" />
                松开鼠标上传视频
              </div>
            </div>,
            document.body,
          )
        : null}

      {referenceId === null || labels === undefined ? null : (
        <ReferenceViewer
          key={referenceId}
          labels={labels}
          listed={listed}
          onAuthor={filterByAuthor}
          onClose={() => onReferenceChange(null, true)}
          onRestoreFocus={() => focusCard(referenceId)}
          referenceId={referenceId}
        />
      )}
    </main>
  )
}

/** 「上传视频」：点了直接选文件，不弹窗；悬停说明另外两种上传方式。 */
function UploadButton({ onPick }: { onPick: () => void }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <Button
          className="h-(--control-height-xl) shrink-0 rounded-full"
          leadingIcon="upload"
          onClick={onPick}
          variant="inverted"
        >
          上传视频
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">将视频拖入本页或在本页粘贴，也可上传</TooltipContent>
    </TooltipRoot>
  )
}

/** 一条都没有时整块列表区就是拖放区：说明三种上传方式，给一个选文件的按钮。 */
function EmptyDropZone({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex min-h-85 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-outline-variant px-6 py-10 text-center">
      <Icon className="text-on-surface-variant" decorative name="add-file" size="lg" />
      <p className="text-title font-medium text-on-surface">
        将视频拖到此处或在本页粘贴，可直接上传
      </p>
      <p className="text-body-sm text-on-surface-faint">
        支持 MP4 或 MOV，单个不超过 512MB；上传后自动拆解并打标签
      </p>
      <Button
        className="mt-2 rounded-full"
        leadingIcon="upload"
        onClick={onPick}
        variant="outlined"
      >
        选择文件
      </Button>
    </div>
  )
}
