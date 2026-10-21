import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT } from '@/shared/api/media-upload'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError } from '@/shared/ui/list-state'
import type { PickerSource } from '@/shared/ui/search-picker'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { placeholderCardHeightFor } from '../library-layout'
import { knownTagIds } from '../library-tags'
import { useLibraryTags } from '../library-tags.api'
import { useReferenceUpload, type PendingUpload } from '../reference-upload'
import {
  isDefaultReferenceScope,
  isReferenceBusy,
  useReferenceFilters,
  useReferences,
  type ReferenceItem,
  type ReferenceScope,
} from '../references.api'
import { focusCardOpener } from './card-focus'
import { LibraryList } from './library-list'
import { LibraryPageHeader } from './library-page-header'
import { useLibraryPageScroll } from './library-page-scroll'
import { LibraryPageShell } from './library-page-shell'
import { LibraryTagAdmin } from './library-tag-admin'
import { LibraryTagAdminPrototype } from './library-tag-admin-prototype'
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
  scope: requestedScope,
  onScopeChange,
  myUserName,
  referenceId,
  onReferenceChange,
}: ReferencesRouteProps) {
  const { mainRef, getScrollElement } = useLibraryPageScroll()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const tagTree = useLibraryTags()
  const tags = tagTree.data?.index
  const { data: user } = useUser()
  const canManageTags = hasPermission(user, PERMISSION.usersManage)
  const [managingTags, setManagingTags] = useState(false)
  // 地址里的标签先对过标签树：树里没有的（如已被删掉）不带去查，免得整页 422；没选标签就不必等树。
  // 树读失败时也照原样去查，列表才有结果，好露出读标签失败的提示与重试，不一直停在骨架上。
  const scope =
    tags === undefined
      ? requestedScope
      : { ...requestedScope, tags: knownTagIds(tags, requestedScope.tags) }
  const references = useReferences(
    scope,
    tags !== undefined || requestedScope.tags.length === 0 || tagTree.isError,
  )
  const loaded = references.data?.pages.flatMap((page) => page.items) ?? []
  const total = references.data?.pages[0]?.total ?? undefined
  const canUpload = references.data?.pages[0]?.canUpload ?? false
  // 列表轮询里每有一行打完（还在跑的行变少），标签树重读一次，条数跟上。
  const busyCount = loaded.filter(isReferenceBusy).length
  const lastBusyCountRef = useRef(busyCount)
  const refetchTags = tagTree.refetch
  useEffect(() => {
    if (busyCount < lastBusyCountRef.current) void refetchTags()
    lastBusyCountRef.current = busyCount
  }, [busyCount, refetchTags])
  const filters = useReferenceFilters()
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

  return (
    <LibraryPageShell
      {...upload.dragHandlers}
      attachments={
        <>
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

          {referenceId === null || tags === undefined ? null : (
            <ReferenceViewer
              key={referenceId}
              listed={listed}
              myUserName={myUserName}
              onAuthor={filterByAuthor}
              onClose={() => onReferenceChange(null, true)}
              onRestoreFocus={() => focusCardOpener(mainRef.current, referenceId)}
              referenceId={referenceId}
              tags={tags}
            />
          )}
        </>
      }
      filters={
        __TAG_ADMIN_PROTOTYPE__ && canManageTags && managingTags && tags !== undefined ? null : (
          <ReferenceFilters
            authors={owners}
            manageTags={
              canManageTags
                ? { onToggle: () => setManagingTags((open) => !open), open: managingTags }
                : undefined
            }
            myUserName={myUserName}
            onChange={onScopeChange}
            scope={scope}
            tags={tags}
            trailing={counter}
          />
        )
      }
      header={
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
      }
      label="资料库"
      mainRef={mainRef}
    >
      {canManageTags && managingTags && tags !== undefined ? (
        __TAG_ADMIN_PROTOTYPE__ ? (
          <LibraryTagAdminPrototype index={tags} onClose={() => setManagingTags(false)} />
        ) : (
          <LibraryTagAdmin index={tags} onClose={() => setManagingTags(false)} />
        )
      ) : (
        <LibraryList
          blocker={
            tags === undefined ? (
              <ListError
                message={errorMessageOf(tagTree.error, '读取标签失败')}
                onRetry={() => void tagTree.refetch()}
              />
            ) : undefined
          }
          empty={
            filtered ? (
              <ListEmpty>暂无匹配的参考视频，请更换关键词或清除筛选</ListEmpty>
            ) : canUpload ? (
              <EmptyDropZone onPick={pickFiles} />
            ) : (
              <ListEmpty>暂无参考视频</ListEmpty>
            )
          }
          errorMessage="读取参考视频失败"
          estimateHeight={(_entry, width) => placeholderCardHeightFor(width)}
          getScrollElement={getScrollElement}
          items={entries}
          keyOf={(entry) => (entry.kind === 'upload' ? entry.upload.key : entry.item.id)}
          pending={tagTree.isPending}
          query={references}
          renderItem={(entry, width) =>
            entry.kind === 'upload' ? (
              <UploadingCard myUserName={myUserName} upload={entry.upload} />
            ) : tags === undefined ? null : (
              <ReferenceCard
                item={entry.item}
                onAuthor={filterByAuthor}
                onOpen={(id) => onReferenceChange(id, false)}
                tags={tags}
                width={width}
              />
            )
          }
          shown={loaded.length}
          skeletonLabel="正在读取参考视频"
          total={total}
        />
      )}
    </LibraryPageShell>
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
