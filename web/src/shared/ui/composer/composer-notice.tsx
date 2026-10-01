/** 附件被上限或文件夹挡下时的就地提示（见 `useAttachmentAdmission`）。播报区要先在才播得出后放进去的字，
 * 所以会出提示的形态一直挂着它，没有提示时是空的。 */

import { Icon } from '@/shared/icons'

export function ComposerNotice({ notice }: { notice: string | null }) {
  return (
    // 不挂 status 角色：所在页面（如图片编辑的任务预览）另有自己的 status，免得互相混淆。
    <div aria-live="polite" data-testid="composer-notice">
      {notice === null ? null : (
        <p className="composer-notice">
          <Icon decorative name="info" size="sm" />
          {notice}
        </p>
      )}
    </div>
  )
}
