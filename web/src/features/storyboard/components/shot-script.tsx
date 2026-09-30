/** 文案列：整组连续排版，全局设定是开头一段，之后每个镜头一段；点哪段选中哪段，舞台跟着切到它的首帧。 */

import type { Ref } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import {
  contentLabel,
  segmentTimeRange,
  updateContentPrompt,
  type ShotContent,
} from '../shot-content'
import type { Shot } from '../shot-document'
import { copyWithToast } from './copy-with-toast'
import { PromptEditor, type PromptEditorHandle } from './prompt-editor'

type ShotScriptProps = {
  shot: Shot
  /** 要排出来的段，见 `scriptSegments`。 */
  segments: readonly ShotContent[]
  selectedId: string
  /** 选中段里正在看的帧，正文里对应的 @N 高亮。 */
  frameNumber: number | undefined
  readOnly: boolean
  editorRef: (id: string) => Ref<PromptEditorHandle>
  onSelect: (content: string, frame?: number) => void
  onUpdateShot: (updater: (current: Shot) => Shot) => unknown
}

export function ShotScript({
  editorRef,
  frameNumber,
  onSelect,
  onUpdateShot,
  readOnly,
  segments,
  selectedId,
  shot,
}: ShotScriptProps) {
  return (
    <div aria-label="分镜文案" className="storyboard-prose" role="region">
      {segments.map((segment) => {
        const selected = segment.id === selectedId
        const label = contentLabel(segment)
        const range = segmentTimeRange(shot, segment)
        // 焦点落进这段（点正文、Tab 进来）或点段标题就选中；已选中的段再点、再打字不重置帧。
        const selectSegment = () => {
          if (!selected) onSelect(segment.id)
        }
        const copy = (
          <IconButton
            className="storyboard-segment-copy"
            label={`复制${label}`}
            name="copy"
            onClick={() => void copyWithToast(segment.prompt ?? '', '已复制')}
            size="sm"
          />
        )
        return (
          <div
            aria-current={selected}
            aria-label={label}
            className={cn(
              'storyboard-segment',
              segment.kind === 'global' && 'storyboard-segment-lede',
            )}
            key={segment.id}
            onFocus={selectSegment}
            role="group"
          >
            {segment.kind === 'global' ? (
              <span className="storyboard-segment-lede-copy">{copy}</span>
            ) : (
              <div className="mb-1.5 flex h-7 min-w-0 items-center gap-2">
                <h4 className="text-title font-semibold text-on-surface">
                  <button
                    className="cursor-pointer rounded-xs ui-focus"
                    onClick={selectSegment}
                    type="button"
                  >
                    {label}
                  </button>
                </h4>
                {range === undefined ? null : (
                  <span className="inline-flex h-5 items-center rounded-full bg-surface-container px-2 text-label text-on-surface-variant tabular-nums">
                    {range}
                  </span>
                )}
                <span className="ml-auto">{copy}</span>
              </div>
            )}
            <PromptEditor
              aria-label={segment.kind === 'global' ? segment.title : `${label} 的描述`}
              frames={shot.image_urls}
              highlighted={selected ? frameNumber : undefined}
              onChange={(text) =>
                onUpdateShot((current) => updateContentPrompt(current, segment.id, text))
              }
              onPickFrame={(number) => {
                if (number >= 1 && number <= shot.image_urls.length) onSelect(segment.id, number)
              }}
              readOnly={readOnly}
              ref={editorRef(segment.id)}
              value={segment.prompt ?? ''}
            />
          </div>
        )
      })}
    </div>
  )
}
