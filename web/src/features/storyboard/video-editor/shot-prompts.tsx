/** 原作的镜头正文只供主动查看、复制到修改要求；不随时间线选区筛选，也不推导其他来源。 */
import { useState } from 'react'
import { Button, IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { historyShotOf, type GenerationJob } from '../storyboard.api'
import './shot-prompts.css'

type ShotPromptsProps = {
  root: GenerationJob
  shotIndex: number | undefined
  canAppend: boolean
  onAppend: (text: string) => void
}

export function ShotPrompts({ root, shotIndex, canAppend, onAppend }: ShotPromptsProps) {
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
        <PopupSurface
          align="end"
          aria-label="镜头提示词"
          className="video-editor-prompts-panel"
          collisionBoundary={host?.parentElement ?? null}
          collisionPadding={12}
          container={host}
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
          side="bottom"
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
                      title={canAppend ? '追加到修改要求末尾' : '请先选中视频段，提交期间无法添加'}
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
