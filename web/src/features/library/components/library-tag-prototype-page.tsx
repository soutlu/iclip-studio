/** 标签管理第二版的临时交互原型；只由 mock 模式的资料库路由挂载。 */
import type { ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { useLibraryTags } from '../library-tags.api'
import { LibraryPageHeader } from './library-page-header'
import { LibraryTagAdminPrototype } from './library-tag-admin-prototype'

export function LibraryTagPrototypePage({
  tabs,
  onClose,
}: {
  tabs: ReactNode
  onClose: () => void
}) {
  const tags = useLibraryTags()
  return (
    <main aria-label="标签管理原型" className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-4 pt-10 pb-8 sm:px-8">
        <LibraryPageHeader
          description="收录从成片素材中挑选的优秀视频及其标签。选择任一视频，可直接基于它再创作。"
          tabs={tabs}
        />
        <div className="pt-6">
          {tags.data ? (
            <LibraryTagAdminPrototype index={tags.data.index} onClose={onClose} />
          ) : tags.isError ? (
            <ListError
              message={errorMessageOf(tags.error, '读取标签失败')}
              onRetry={() => void tags.refetch()}
            />
          ) : (
            <ListPending label="正在读取标签…" />
          )}
        </div>
        <p className="mt-6 text-caption text-on-surface-faint">
          交互原型 · 使用演示数据，修改在刷新后重置。
        </p>
      </div>
    </main>
  )
}
