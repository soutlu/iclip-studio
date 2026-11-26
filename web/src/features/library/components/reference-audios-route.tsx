import { useState, type ReactNode } from 'react'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { AuditionBar, audioTraitsText, useAudition } from '@/shared/ui/audition'
import { Button } from '@/shared/ui/button'
import { DialogRoot } from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import type { ReferenceAudioScope } from '../reference-audios.api'
import { AddAudioDialog, EditAudioDialog, RemoveAudioDialog } from './audio-dialogs'
import { LOCAL_AUDITION_ID } from './audio-file-field'
import { AllAudios, AllTotal, KindAudios, KindTotal } from './audio-lists'
import type { AudioRowActions } from './audio-table'
import { AudioToolbar } from './audio-toolbar'
import { LibraryPageHeader } from './library-page-header'
import { useLibraryPageScroll } from './library-page-scroll'
import { LibraryPageShell } from './library-page-shell'

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; audio: ReferenceAudio }
  | { kind: 'remove'; audio: ReferenceAudio }
  | null

type ReferenceAudiosRouteProps = {
  tabs: ReactNode
  scope: ReferenceAudioScope
  onScopeChange: (next: ReferenceAudioScope) => void
}

/**
 * 资料库的「音频库」：音色、配乐、音效各一张表（默认音色），按属性多选筛、按关键词搜（名称、描述与台词），
 * 往下滚接着读；「全部」分三段各列最新几条。点封面试听（同一时间只放一条，切走时停下），底部试听条能拖着跳。
 * 能上传的人可以添加，属主或治理者（`canEdit`）可以改、移除。
 */
export function ReferenceAudiosRoute({ tabs, scope, onScopeChange }: ReferenceAudiosRouteProps) {
  const { mainRef, getScrollElement } = useLibraryPageScroll()
  const { data: user } = useUser()
  const canAdd = hasPermission(user, PERMISSION.uploadsWrite)
  const [dialog, setDialog] = useState<Dialog>(null)
  // 切到别的页签时这一页卸掉，试听跟着停
  const audition = useAudition({
    active: true,
    onError: () => toast.error('音频试听失败，请重试'),
  })
  // 试听条要的标题、属性和波形：点的时候记下这一条，换了筛选、列表里看不到它时试听条照样在
  const [auditioned, setAuditioned] = useState<ReferenceAudio | null>(null)
  const actions: AudioRowActions = {
    audition,
    onEdit: (audio) => setDialog({ kind: 'edit', audio }),
    onRemove: (audio) => setDialog({ kind: 'remove', audio }),
    onToggle: (audio) => {
      setAuditioned(audio)
      audition.toggle(audio.id, audio.url)
    },
  }
  const close = () => {
    if (audition.current === LOCAL_AUDITION_ID) audition.stop()
    setDialog(null)
  }
  const barAudio = auditioned?.id === audition.current ? auditioned : null

  return (
    <LibraryPageShell
      attachments={
        <>
          {barAudio === null ? null : (
            // 挂在滚动区的末尾：列表短时也贴着视口底边，长时滚到底停在最后一行下面，不挡住它
            <div className="sticky bottom-5 mt-auto mb-5 flex justify-center px-4 sm:px-(--layout-list-page-gutter)">
              <div className="w-full max-w-190">
                <AuditionBar
                  audition={audition}
                  detail={audioTraitsText(barAudio)}
                  durationMs={barAudio.durationMs}
                  onToggle={() => audition.toggle(barAudio.id, barAudio.url)}
                  peaks={barAudio.peaks}
                  title={barAudio.title}
                />
              </div>
            </div>
          )}
          <DialogRoot
            onOpenChange={(open) => {
              if (!open) close()
            }}
            open={dialog !== null}
          >
            {dialog === null ? null : dialog.kind === 'add' ? (
              <AddAudioDialog
                audition={audition}
                initialKind={scope.kind === 'all' ? 'voice' : scope.kind}
                onDone={close}
              />
            ) : dialog.kind === 'edit' ? (
              <EditAudioDialog audio={dialog.audio} key={dialog.audio.id} onDone={close} />
            ) : (
              <RemoveAudioDialog audio={dialog.audio} onDone={close} />
            )}
          </DialogRoot>
        </>
      }
      filters={
        <AudioToolbar
          onScopeChange={onScopeChange}
          scope={scope}
          summary={
            scope.kind === 'all' ? (
              <AllTotal q={scope.q} />
            ) : (
              <KindTotal kind={scope.kind} q={scope.q} traits={scope.traits} />
            )
          }
        />
      }
      header={
        <LibraryPageHeader
          action={
            canAdd ? (
              <Button
                className="h-(--control-height-xl) shrink-0 rounded-full"
                leadingIcon="add"
                onClick={() => setDialog({ kind: 'add' })}
                variant="inverted"
              >
                添加音频
              </Button>
            ) : undefined
          }
          description="收录音色、配乐与音效。音色用于 final-cut 的 AI 配音，配乐与音效可加入时间线。"
          search={{
            label: '搜索音频',
            onSearch: (q) => onScopeChange({ ...scope, q }),
            placeholder: '搜索名称、风格或台词…',
            value: scope.q,
          }}
          tabs={tabs}
        />
      }
      label="资料库"
      mainRef={mainRef}
    >
      {scope.kind === 'all' ? (
        <AllAudios
          actions={actions}
          canAdd={canAdd}
          onOpenKind={(kind) => onScopeChange({ kind, q: scope.q, traits: {} })}
          q={scope.q}
        />
      ) : (
        <KindAudios
          actions={actions}
          canAdd={canAdd}
          getScrollElement={getScrollElement}
          kind={scope.kind}
          q={scope.q}
          traits={scope.traits}
        />
      )}
    </LibraryPageShell>
  )
}
