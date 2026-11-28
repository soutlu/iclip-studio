import { useEffect, useId, useRef, useState } from 'react'
import { Input } from '@/shared/ui/field'
import { trimBounds, trimmed, type SourceLength, type Timing } from './clip-edit'
import type { FilmClip } from './composition/film'
import { PropRow } from './ui/prop-layout'

// 「−」「+」单次增减步长（毫秒）
const DURATION_STEP_MS = 500

const seconds = (ms: number) => (ms / 1000).toFixed(2)

/** 将输入的秒数文本（允许带「秒」或 `s` 后缀）解析为毫秒并保留两位小数精度；非法输入返回 `null`。 */
const parseSeconds = (text: string): number | null => {
  const cleaned = text
    .trim()
    .replace(/\s*(秒|s)$/i, '')
    .trim()
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? Math.round(value * 100) * 10 : null
}

/**
 * 「时长」一行：右边一体的「− 秒数 +」胶囊，「−」「+」一次 0.5 秒，中间的秒数能直接输入（回车或失焦提交，Esc 放弃，
 * 非法值还原）。调整作用于片段右端并遵循右端裁切边界：不侵占同行后续片段，且不短于最短片段时长。
 */
export function DurationStepper({
  clip,
  clips,
  sourceMs,
  onRetime,
  onEditing,
}: {
  clip: FilmClip
  clips: readonly FilmClip[]
  sourceMs: SourceLength
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  onEditing: (editing: boolean) => void
}) {
  const id = useId()
  const bounds = trimBounds(clip, 'end', clips, sourceMs(clip))
  const lengthTo = (ms: number) => {
    const timing = trimmed(clip, 'end', clip.start + ms, bounds)
    if (timing.duration !== clip.duration) onRetime(new Map([[clip.id, timing]]))
  }
  const [draft, setDraft] = useState<string | null>(null)
  // 按 Esc 时先清空草稿再触发失焦，onBlur 直接读取该 ref，避免等待重新渲染
  const draftRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }
  // 输入框聚焦期间若因外部重载被卸载，不会触发 onBlur，需在卸载清理中复位编辑态
  useEffect(() => () => onEditing(false), [onEditing])
  const end = clip.start + clip.duration
  return (
    <PropRow htmlFor={id} label="时长">
      <span className="wf-prop-well wf-stepper">
        <button
          aria-label="缩短 0.5 秒"
          className="wf-stepper-step ui-state ui-focus"
          disabled={end <= bounds.min}
          onClick={() => lengthTo(clip.duration - DURATION_STEP_MS)}
          type="button"
        >
          −
        </button>
        <span className="wf-stepper-value">
          <Input
            autoComplete="off"
            className="wf-stepper-input"
            id={id}
            inputMode="decimal"
            onBlur={() => {
              onEditing(false)
              const parsed = draftRef.current === null ? null : parseSeconds(draftRef.current)
              edit(null)
              if (parsed !== null) lengthTo(parsed)
            }}
            onChange={(event) => edit(event.target.value)}
            onFocus={() => onEditing(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              else if (event.key === 'Escape') {
                edit(null)
                event.currentTarget.blur()
              }
            }}
            value={draft ?? seconds(clip.duration)}
          />
          <span aria-hidden="true">s</span>
        </span>
        <button
          aria-label="延长 0.5 秒"
          className="wf-stepper-step ui-state ui-focus"
          disabled={end >= bounds.max}
          onClick={() => lengthTo(clip.duration + DURATION_STEP_MS)}
          type="button"
        >
          +
        </button>
      </span>
    </PropRow>
  )
}
