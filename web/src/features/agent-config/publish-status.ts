/** 编辑器的保存与发布状态；`published` 表示页面内容与已发布版本一致。 */
type PublishStatus = {
  kind: 'unsaved' | 'never-published' | 'unpublished' | 'published'
  label: string
}

/**
 * 推导 Agent 与技能编辑器共用的保存与发布状态，按优先级依次判断。
 *
 * @param unsaved 页面上是否有未保存的修改
 * @param hasUnpublishedChanges 后端给出的已存草稿是否与当前版本不同
 * @param publishedVersion 已发布的版本号，从没发布过时为 `null`
 */
export function publishStatusOf(
  unsaved: boolean,
  hasUnpublishedChanges: boolean,
  publishedVersion: number | null,
): PublishStatus {
  if (unsaved) return { kind: 'unsaved', label: '有未保存的修改' }
  if (publishedVersion === null) return { kind: 'never-published', label: '尚未发布' }
  if (hasUnpublishedChanges) return { kind: 'unpublished', label: '已保存，未发布' }
  return { kind: 'published', label: `已发布 v${publishedVersion}` }
}
