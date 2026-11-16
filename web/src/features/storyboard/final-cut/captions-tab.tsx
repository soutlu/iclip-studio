import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { BlockedReason } from '../components/blocked-reason'
import { captionClock, captionsInOrder } from './caption-edit'
import type { CaptionClip } from './composition/film'

// 照「内容与样式」里的文字框：改字停下 300 毫秒再写进 final-cut
const COMMIT_DELAY_MS = 300

const ADD_LABEL = '在播放头处加一句'

type CaptionsTabProps = {
  captions: readonly CaptionClip[]
  /** 为什么现在不能在播放头处加一句；给了就把按钮置灰，点了说明它。 */
  addBlocked: string | undefined
  /** 字幕写法不对时的原因，显示在最上面。 */
  problem: string | undefined
  /** 在播放头处加一句，答复新字幕的编号；没加上时是 undefined。 */
  onAdd: () => Promise<string | undefined>
  onText: (id: string, text: string) => void
  onRemove: (id: string) => void
  onSeek: (ms: number) => void
}

/**
 * 「字幕」页签：在播放头处加一句，下面是按开始时间排的字幕列表，每句能直接改字、删掉，点时间跳到它的开始。
 * 刚加的那一句标成当前这一句，焦点进它的文字框。
 */
export function CaptionsTab({
  captions,
  addBlocked,
  problem,
  onAdd,
  onText,
  onRemove,
  onSeek,
}: CaptionsTabProps) {
  const [current, setCurrent] = useState<string | null>(null)
  const [focusing, setFocusing] = useState<string | null>(null)
  const add = async () => {
    if (addBlocked !== undefined) return
    const id = await onAdd()
    if (id === undefined) return
    setCurrent(id)
    setFocusing(id)
  }
  return (
    <div className="wf-captions">
      {problem === undefined ? null : (
        <InlineAlert className="wf-captions-alert" message={problem} />
      )}
      <div className="wf-captions-actions">
        <BlockedReason reason={addBlocked}>
          <Button
            aria-disabled={addBlocked === undefined ? undefined : true}
            className="wf-captions-add"
            leadingIcon="add"
            onClick={() => void add()}
            size="md"
            variant="outlined"
          >
            {ADD_LABEL}
          </Button>
        </BlockedReason>
      </div>
      {captions.length === 0 ? (
        <p className="wf-captions-note" role="status">
          暂无字幕，请点击「{ADD_LABEL}」
        </p>
      ) : (
        <ol aria-label="字幕" className="wf-caption-list">
          {captionsInOrder(captions).map((caption) => (
            <CaptionRow
              caption={caption}
              current={caption.id === current}
              focus={caption.id === focusing}
              key={caption.id}
              onFocused={() => setFocusing(null)}
              onRemove={() => onRemove(caption.id)}
              onSeek={() => {
                setCurrent(caption.id)
                onSeek(caption.start)
              }}
              onText={onText}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

type CaptionRowProps = {
  caption: CaptionClip
  current: boolean
  /** 焦点要进这一句的文字框（刚加的那一句）。 */
  focus: boolean
  onFocused: () => void
  onText: (id: string, text: string) => void
  onRemove: () => void
  onSeek: () => void
}

/**
 * 一句字幕：起止时间、删除钮和文字框。改了先留在框里，停下 300 毫秒再写进去；输入法拼字时不计时，焦点离开、
 * 这一行没了时把没写的立刻写进去。
 */
function CaptionRow({
  caption,
  current,
  focus,
  onFocused,
  onText,
  onRemove,
  onSeek,
}: CaptionRowProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ id: caption.id, onText })
  useLayoutEffect(() => {
    latestRef.current = { id: caption.id, onText }
  })
  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    const text = draftRef.current
    if (text === null) return
    draftRef.current = null
    setDraft(null)
    latestRef.current.onText(latestRef.current.id, text)
  }, [])
  useEffect(() => flush, [flush])

  const composingRef = useRef(false)
  const schedule = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = composingRef.current ? null : setTimeout(flush, COMMIT_DELAY_MS)
  }

  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!focus) return
    fieldRef.current?.focus()
    fieldRef.current?.select()
    onFocused()
  }, [focus, onFocused])

  const range = `${captionClock(caption.start)} – ${captionClock(caption.start + caption.duration)}`
  return (
    <li
      aria-current={current ? 'true' : undefined}
      className={cn('wf-caption', current && 'is-current')}
    >
      <div className="wf-caption-head">
        <button className="wf-caption-time" onClick={onSeek} type="button">
          {range}
        </button>
        <IconButton label={`删除 ${range} 的字幕`} name="delete" onClick={onRemove} size="xs" />
      </div>
      <Textarea
        aria-label={`字幕文字 ${range}`}
        className="wf-caption-text"
        onBlur={flush}
        onChange={(event) => {
          draftRef.current = event.target.value
          setDraft(event.target.value)
          schedule()
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          schedule()
        }}
        onCompositionStart={() => {
          composingRef.current = true
          schedule()
        }}
        ref={fieldRef}
        rows={2}
        value={draft ?? caption.text}
      />
    </li>
  )
}
