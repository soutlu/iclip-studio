import { useCallback, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError, NextPageFooter } from '@/shared/ui/list-state'
import type { PickerSource } from '@/shared/ui/search-picker'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { placeholderCardHeightFor } from '../library-layout'
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
import { focusCardOpener } from './card-focus'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'
import { LibraryPageHeader } from './library-page-header'
import { ReferenceCard, UploadingCard } from './reference-card'
import { ReferenceFilters } from './reference-filters'
import { ReferenceViewer } from './reference-viewer'

type GridEntry =
  { kind: 'upload'; upload: PendingUpload } | { kind: 'reference'; item: ReferenceItem }

type ReferencesRouteProps = {
  tabs: ReactNode
  scope: ReferenceScope
  onScopeChange: (next: ReferenceScope) => void
  myUserName: string | null
  referenceId: string | null
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

  const filterByAuthor = (userName: string) => onScopeChange({ ...scope, userName })

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
        estimateHeight={(_entry, width) => placeholderCardHeightFor(width)}
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
          myUserName={myUserName}
          onAuthor={filterByAuthor}
          onClose={() => onReferenceChange(null, true)}
          onRestoreFocus={() => focusCardOpener(mainRef.current, referenceId)}
          referenceId={referenceId}
        />
      )}
    </main>
  )
}

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
