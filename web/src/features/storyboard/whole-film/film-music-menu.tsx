import { useRef, useState } from 'react'
import { MEDIA_AUDIO_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { BlockedReason } from '../components/blocked-reason'
import { MAX_MUSIC_PROMPT_CHARS } from './film-limits'
import type { MusicDescription } from './whole-film.api'

type MusicMenuProps = {
  container: HTMLElement | null
  description: MusicDescription
  onOpenGenerate: () => void
  onGenerate: (prompt: string) => Promise<boolean>
  onUpload: (file: File) => void
  busy: boolean
  generateBlocked: string | undefined
}

const promptBlockedReason = (description: MusicDescription, prompt: string): string | undefined => {
  if (description.kind === 'loading') return '正在读取工程文件，暂时无法生成'
  if (description.kind === 'failed') return '工程文件读取失败，无法生成；请重试'
  if (prompt.trim() === '') return '尚未填写音乐描述，无法生成；请用一句话描述想要的音乐'
  return undefined
}

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
  // Radix 菜单收起时会把焦点还给触发按钮，生成面板会因焦点落在外面立刻关掉，选「生成音乐」时要拦下。
  const openingPanelRef = useRef(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const prompt = description.kind === 'ready' ? (description.text ?? draft) : ''
  const reason =
    generateBlocked ??
    (busy ? '正在处理音乐，暂时无法生成' : promptBlockedReason(description, prompt))

  const generate = async () => {
    if (reason !== undefined) return
    if (await onGenerate(prompt)) setPanelOpen(false)
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
                maxLength={MAX_MUSIC_PROMPT_CHARS}
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
              <BlockedReason reason={reason}>
                <Button
                  aria-disabled={reason === undefined ? undefined : true}
                  onClick={() => void generate()}
                  size="md"
                >
                  {busy ? (
                    <Icon
                      className="motion-safe:animate-spin"
                      decorative
                      name="loading"
                      size="md"
                    />
                  ) : (
                    <Icon decorative name="music" size="md" />
                  )}
                  生成
                </Button>
              </BlockedReason>
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
