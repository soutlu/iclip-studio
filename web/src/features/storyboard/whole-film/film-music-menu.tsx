/** 音乐轨轨道头上的「+」：向上展开「上传音乐」「生成音乐」。生成音乐另开一块面板（输入框放在菜单里会被菜单的
 * 键盘导航抢走焦点）：工程文件里写了配乐就只读引用那段原文，原样当提示词；没有工程文件或没写配乐时让人写一句。 */

import { useRef, useState } from 'react'
import { MEDIA_AUDIO_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import type { MusicDescription } from './whole-film.api'

type MusicMenuProps = {
  /** 面板挂在编辑器里：编辑器是模态弹窗，挂到外面就收不到焦点。 */
  container: HTMLElement | null
  description: MusicDescription
  /** 生成面板打开了：这时才去读工程文件。 */
  onOpenGenerate: () => void
  /** 提交生成；成功才收起面板，失败由调用方提示。 */
  onGenerate: (prompt: string) => Promise<boolean>
  onUpload: (file: File) => void
  /** 正在上传或提交时不能再加。 */
  busy: boolean
  /** 现在不能生成的原因（如还没读到对话的需求单）；能生成时没有。 */
  generateBlocked: string | undefined
}

/** 提示词至多多少字（音乐模型的上限，后端同样拦）。 */
const MAX_PROMPT = 3000

export function MusicMenu({
  container,
  description,
  onOpenGenerate,
  onGenerate,
  onUpload,
  busy,
  generateBlocked,
}: MusicMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  // 选了「生成音乐」：菜单收起时别把焦点还给「+」，否则面板一打开就因焦点落在外面而关掉。
  const openingPanelRef = useRef(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const prompt = description.kind === 'ready' ? (description.text ?? draft) : undefined
  const reason =
    generateBlocked ??
    (prompt !== undefined && prompt.trim() === '' ? '请先用一句话描述想要的音乐' : undefined)

  const generate = async () => {
    if (prompt === undefined || reason !== undefined || submitting) return
    setSubmitting(true)
    const done = await onGenerate(prompt)
    setSubmitting(false)
    if (done) setPanelOpen(false)
  }

  return (
    <>
      <PopupRoot onOpenChange={setPanelOpen} open={panelOpen}>
        <MenuRoot>
          <PopupAnchor asChild>
            <MenuTrigger asChild>
              <button
                aria-label="添加音乐"
                className="film-timeline-head-add ui-state ui-focus"
                disabled={busy}
                type="button"
              >
                <Icon decorative name="add" size="xs" />
              </button>
            </MenuTrigger>
          </PopupAnchor>
          <MenuSurface
            align="start"
            className="film-menu-small"
            onCloseAutoFocus={(event) => {
              if (!openingPanelRef.current) return
              openingPanelRef.current = false
              event.preventDefault()
            }}
            side="top"
          >
            <MenuItem icon="upload" onSelect={() => fileRef.current?.click()}>
              上传音乐
            </MenuItem>
            <MenuItem
              icon="music"
              onSelect={() => {
                openingPanelRef.current = true
                setPanelOpen(true)
                onOpenGenerate()
              }}
            >
              生成音乐
            </MenuItem>
          </MenuSurface>
        </MenuRoot>
        <PopupSurface
          align="start"
          aria-label="生成音乐"
          className="film-music-panel"
          collisionPadding={12}
          container={container}
          side="top"
          sideOffset={6}
        >
          <p className="film-menu-head">生成音乐</p>
          <div className="film-music-panel-body">
            {description.kind === 'loading' ? (
              <p className="film-music-panel-note" role="status">
                正在读取工程文件…
              </p>
            ) : description.kind === 'failed' ? (
              <InlineAlert
                action={{ label: '重试', onClick: description.onRetry }}
                message={description.message}
              />
            ) : description.text === null ? (
              <textarea
                aria-label="音乐描述"
                className="film-card-text ui-focus ui-focus-inline"
                maxLength={MAX_PROMPT}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="用一句话描述想要的音乐"
                rows={3}
                value={draft}
              />
            ) : (
              <blockquote className="film-music-quote">
                <span>使用工程文件里的配乐：</span>
                {description.text}
              </blockquote>
            )}
            <div className="film-music-panel-foot">
              <p>{generateBlocked ?? '生成后放到音乐轨，自动对齐切点'}</p>
              <Button
                disabled={prompt === undefined || reason !== undefined}
                leadingIcon="music"
                loading={submitting}
                onClick={() => void generate()}
                size="md"
                title={reason}
              >
                生成
              </Button>
            </div>
          </div>
        </PopupSurface>
      </PopupRoot>
      <input
        accept={MEDIA_AUDIO_ACCEPT}
        aria-label="选择音乐文件"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) onUpload(file)
        }}
        ref={fileRef}
        tabIndex={-1}
        type="file"
      />
    </>
  )
}
