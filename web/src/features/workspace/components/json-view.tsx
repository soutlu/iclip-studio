/**
 * JSON 的标准格式化视图：保留引号、括号与 2 空格缩进，左侧留一栏放折叠箭头，不显示行号。
 * 键、字符串、数字与 true / false / null 各用一种代码着色，标点保持淡灰；每层缩进画一条极淡的参考线，
 * 悬停行铺一层淡灰，收起的摘要带一枚项数小胶囊。长字符串在框内换行、续行对齐缩进。
 * 图片地址原文不改，行尾附一张小缩略图，点开走共享灯箱。
 */

import { type CSSProperties, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import type { JsonLine, JsonPath, JsonPrimitive } from '../json-format'
import type { JsonFold } from '../use-json-fold'

const IMAGE_URL = /^(data:image\/|https?:\/\/.+\.(?:jpe?g|png|webp|gif|avif|svg)(?:[?#].*)?$)/i

/** 灯箱标题只留地址最后一段，够认出是哪张图；data 地址没有名字。 */
const tailOf = (url: string): string => {
  if (url.startsWith('data:')) return '图片'
  const path = url.split(/[?#]/, 1)[0] ?? url
  return path.slice(path.lastIndexOf('/') + 1) || '图片'
}

export function JsonView({ fold }: { fold: JsonFold }) {
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  return (
    <>
      <div className="font-mono text-body-sm leading-5">
        {fold.lines.map((line) => (
          <JsonRow key={line.id} line={line} onPreview={setPreview} onToggle={fold.toggle} />
        ))}
      </div>
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}

/** 解析失败：红色 × 加一句灰字，下面原样显示原文（等宽、不折叠）。 */
export function JsonParseFailure({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-1.5 text-body-sm text-chat-secondary-text">
        <Icon className="shrink-0 text-chat-status-error" decorative name="failed" size="sm" />
        JSON 格式有误，按原文显示
      </p>
      <pre className="font-mono text-body-sm leading-5 wrap-anywhere whitespace-pre-wrap text-on-surface">
        {text}
      </pre>
    </div>
  )
}

/**
 * 每层缩进一条 1px 参考线，落在上层括号字符的正中（2ch 一档，偏移 0.5ch）；
 * 背景只铺在缩进区内，正文与折行续行不受影响。根层没有缩进，不画。
 */
const indentStyle = (depth: number): CSSProperties => {
  const indent = `${depth * 2}ch`
  if (depth === 0) return { paddingLeft: indent }
  return {
    backgroundImage:
      'repeating-linear-gradient(to right, var(--color-code-guide) 0 1px, transparent 1px 2ch)',
    backgroundPosition: '0.5ch 0',
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${indent} 100%`,
    paddingLeft: indent,
  }
}

const Punct = ({ children }: { children: string }) => (
  <span className="text-on-surface-faint">{children}</span>
)

type JsonRowProps = {
  line: JsonLine
  onToggle: (path: JsonPath) => void
  onPreview: (media: LightboxMedia) => void
}

function JsonRow({ line, onPreview, onToggle }: JsonRowProps) {
  const { body } = line
  const foldable = body.type === 'open' || body.type === 'folded' ? body : undefined
  return (
    <div className="grid grid-cols-[--spacing(5)_minmax(0,1fr)] rounded-xs hover:bg-state-hover">
      <span className="flex justify-center">
        {foldable === undefined ? null : (
          <button
            aria-expanded={foldable.type === 'open'}
            aria-label={`${foldable.type === 'open' ? '收起' : '展开'} ${foldable.label}`}
            className="grid size-5 ui-state cursor-pointer place-items-center rounded-xs text-on-surface-faint ui-focus ui-focus-inline"
            onClick={() => onToggle(foldable.path)}
            type="button"
          >
            <Icon
              className={cn('ui-motion-s', foldable.type === 'open' && 'rotate-90')}
              decorative
              name="disclosure"
              size="xs"
            />
          </button>
        )}
      </span>
      {/* 缩进用左内边距而不是空格：长字符串折行时续行对齐到同一缩进，参考线也随整行高度连贯。 */}
      <span className="min-w-0 wrap-anywhere whitespace-pre-wrap" style={indentStyle(line.depth)}>
        {line.key === undefined ? null : (
          <>
            <span className="text-code-key">{JSON.stringify(line.key)}</span>
            <Punct>: </Punct>
          </>
        )}
        <LineBody body={body} />
        {line.comma ? <Punct>,</Punct> : null}
        {body.type === 'folded' ? (
          <span className="ml-1.5 inline-flex h-4.5 items-center rounded-full border-[0.5px] border-chat-hairline px-1.75 align-[1px] font-sans text-caption text-on-surface-variant">
            {body.count} 项
          </span>
        ) : null}
        {body.type === 'value' && typeof body.value === 'string' && IMAGE_URL.test(body.value) ? (
          <Thumbnail onPreview={onPreview} url={body.value} />
        ) : null}
      </span>
    </div>
  )
}

function LineBody({ body }: { body: JsonLine['body'] }) {
  switch (body.type) {
    case 'value':
      return <Primitive value={body.value} />
    case 'empty':
      return <Punct>{body.brackets}</Punct>
    case 'open':
      return <Punct>{body.bracket}</Punct>
    case 'close':
      return <Punct>{body.bracket}</Punct>
    case 'folded':
      return <Punct>{body.brackets}</Punct>
  }
}

function Primitive({ value }: { value: JsonPrimitive }) {
  if (typeof value === 'string') {
    return <span className="text-code-string">{JSON.stringify(value)}</span>
  }
  return <span className="text-code-literal">{String(value)}</span>
}

function Thumbnail({ onPreview, url }: { onPreview: (media: LightboxMedia) => void; url: string }) {
  const name = tailOf(url)
  return (
    <button
      aria-label={`查看图片：${name}`}
      className="ml-2 inline-block cursor-zoom-in overflow-hidden rounded-xs border-[0.5px] border-chat-hairline bg-thumb-fallback align-middle ui-focus"
      onClick={() => onPreview({ kind: 'image', name, url })}
      type="button"
    >
      <img alt="" className="block h-7.5 w-auto max-w-20 object-cover" src={url} />
    </button>
  )
}
