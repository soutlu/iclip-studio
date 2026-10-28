import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { placeCard } from '../editing/card-placement'
import { spanName, type EditBlock } from './edit-blocks'

type EditBlockCardProps = {
  block: EditBlock
  picked: boolean
  anchorRef: RefObject<HTMLElement | null>
  onUseOriginal: () => void
  onClose: () => void
}

const summaryOf = (block: EditBlock, picked: boolean) => {
  switch (block.state.kind) {
    case 'ready':
      return {
        title: block.name,
        line: `${block.state.duration.toFixed(1)} 秒 · ${picked ? '已选用' : '未选用'}`,
        failed: false,
      }
    case 'running':
      return {
        title: `${spanName(block)} · 生成中`,
        line: '生成完成后显示在编辑轨，点击即可选用',
        failed: false,
      }
    case 'measuring':
      return {
        title: `${spanName(block)} · 读取中`,
        line: '正在读取结果时长，读取完成后点击即可选用',
        failed: false,
      }
    case 'failed':
      return { title: `${spanName(block)} · 生成失败`, line: block.state.message, failed: true }
    case 'unreadable':
      return {
        title: `${spanName(block)} · 无法读取`,
        line: '结果时长读取失败，无法选用；请重新选中这几个镜头再生成',
        failed: true,
      }
  }
}

/** 点编辑轨上的一条编辑片段弹出的小卡：可用的写时长与选用，附「改用原片」；在跑、失败的只说状态。 */
export function EditBlockCard({
  block,
  picked,
  anchorRef,
  onUseOriginal,
  onClose,
}: EditBlockCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  const summary = summaryOf(block, picked)
  const thumb =
    block.state.kind === 'ready' && block.job.outputUrl !== null
      ? videoSnapshotUrl(block.job.outputUrl, 60, 0)
      : undefined

  // 横向对准选区中点，尖角指向它；同 AI 改段卡的摆法。
  const place = useEffectEvent(() => {
    const card = cardRef.current
    const stage = card?.offsetParent
    const anchor = anchorRef.current
    if (card === null || !(stage instanceof HTMLElement) || anchor === null) return
    const stageBounds = stage.getBoundingClientRect()
    const anchorBounds = anchor.getBoundingClientRect()
    const { left, notch } = placeCard(
      stage.clientWidth,
      anchorBounds.left + anchorBounds.width / 2 - stageBounds.left,
      card.offsetWidth,
    )
    card.style.left = `${left}px`
    card.style.setProperty('--card-notch', `${notch}px`)
  })
  useLayoutEffect(() => place())
  useEffect(() => {
    const card = cardRef.current
    const stage = card?.offsetParent
    const observer = new ResizeObserver(() => place())
    if (stage instanceof HTMLElement) observer.observe(stage)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', place, true)
    }
  }, [])

  return (
    <section
      aria-label="编辑片段"
      className="video-editor-card video-editor-block-card animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none"
      ref={cardRef}
    >
      <div className="video-editor-card-head">
        {thumb === undefined ? (
          <span className={cn('video-editor-block-card-icon', summary.failed && 'is-failed')}>
            <Icon decorative name={summary.failed ? 'alert' : 'sparkles'} size="sm" />
          </span>
        ) : (
          <img alt="" className="video-editor-card-frame" draggable={false} src={thumb} />
        )}
        <div className="video-editor-card-title">
          <p>{summary.title}</p>
          <p
            className={cn(summary.failed && 'is-failed')}
            role={summary.failed ? 'alert' : undefined}
          >
            {summary.line}
          </p>
        </div>
        {picked ? (
          <Button
            className="video-editor-block-card-original"
            onClick={onUseOriginal}
            size="md"
            variant="outlined"
          >
            改用原片
          </Button>
        ) : null}
        <IconButton label="关闭" name="close" onClick={onClose} size="sm" />
      </div>
    </section>
  )
}
