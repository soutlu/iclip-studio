import { useState, type Ref } from 'react'
import { Button, IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { historyShotOf, type GenerationJob } from '../storyboard.api'
import './shot-prompts.css'

type ShotPromptsProps = {
  root: GenerationJob
  shotIndex: number | undefined
  canAppend: boolean
  onAppend: (text: string) => void
  /** 打开时挂上的面板，关上后为 null。 */
  panelRef?: Ref<HTMLDivElement> | undefined
}

/** 镜头提示词：工具条上的按钮，面板从按钮往上弹、右端对齐按钮。 */
export function ShotPrompts({ root, shotIndex, canAppend, onAppend, panelRef }: ShotPromptsProps) {
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const shot = historyShotOf(root)

  return (
    <div className="video-editor-prompts" ref={setHost}>
      <PopupRoot onOpenChange={setOpen} open={open}>
        <PopupTrigger asChild>
          <Button leadingIcon="file" size="md" variant="ghost">
            镜头提示词
          </Button>
        </PopupTrigger>
        {/* 挂在宿主里：挂到 body 时，编辑器弹窗的 FocusScope 会在节点移除时把面板关掉。 */}
        <PopupSurface
          align="end"
          aria-label="镜头提示词"
          className="video-editor-prompts-panel"
          // 往上弹时最高到编辑器弹窗顶边留 12px，放不下就在面板里滚动。
          collisionBoundary={host?.closest('[role="dialog"]') ?? []}
          collisionPadding={12}
          container={host}
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
          ref={panelRef}
          side="top"
          sideOffset={8}
        >
          <header className="video-editor-prompts-head">
            <div>
              <h3>镜头提示词</h3>
              <p>{shotIndex === undefined ? '' : `镜头组 ${shotIndex} · `}原始生成提示词</p>
            </div>
            <IconButton
              label="关闭镜头提示词"
              name="close"
              onClick={() => setOpen(false)}
              size="sm"
            />
          </header>
          <div className="video-editor-prompts-body">
            {shot === undefined ? (
              <p className="video-editor-prompts-empty">暂无镜头提示词</p>
            ) : (
              <ol>
                {shot.timeline.map((item, index) => (
                  <li key={item.timestamps.join(':')}>
                    <div className="video-editor-prompt-heading">
                      <h4>镜头 {index + 1}</h4>
                      <span>{item.timestamps.map((time) => time.toFixed(1)).join(' – ')} 秒</span>
                    </div>
                    <p className="video-editor-prompt-text">{item.prompt}</p>
                    <Button
                      aria-label={`复制镜头 ${index + 1} 到输入框`}
                      disabled={!canAppend}
                      leadingIcon="copy"
                      onClick={() => onAppend(item.prompt)}
                      size="md"
                      title={
                        canAppend
                          ? '追加到修改要求末尾'
                          : '未选中视频段或正在提交，无法复制到输入框；请选中视频段并等待提交完成'
                      }
                      variant="ghost"
                    >
                      复制到输入框
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </PopupSurface>
      </PopupRoot>
    </div>
  )
}
