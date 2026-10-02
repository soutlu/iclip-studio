/** 正文可能包含不可信 HTML。按 react-markdown Security 建议，在 rehype-raw 后执行 rehype-sanitize，过滤脚本、事件属性及危险协议。 */

import { createContext, use, useRef, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { VideoPlayer } from '@/shared/ui/video-player'
import { CodeBlock } from './code-block'

/** 在 rehype-sanitize 默认白名单上增加视频及尺寸、播放属性。 */
const SANITIZE = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.['img'] ?? []), 'alt', 'title', 'width', 'height'],
    source: [...(defaultSchema.attributes?.['source'] ?? []), 'src', 'type'],
    video: ['src', 'poster', 'controls', 'loop', 'muted', 'playsInline', 'width', 'height'],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'video', 'figure', 'figcaption'],
}

const CODE_INLINE = cn(
  'rounded-xs bg-chat-code-bg px-1.5 py-0.5',
  'font-mono text-body-sm text-chat-message-text',
)

const CELL = 'border-[0.5px] border-chat-hairline px-3 py-2 text-left align-top'

/** 链接里的图片点击交给链接本身，不另开灯箱。 */
const InsideLinkContext = createContext(false)

/** 正文图片点开进灯箱。 */
function MarkdownImage({ alt, height, src, title, width }: ComponentProps<'img'>) {
  const inLink = use(InsideLinkContext)
  const [open, setOpen] = useState(false)
  const image = <img alt={alt ?? ''} height={height} src={src} title={title} width={width} />
  if (inLink || typeof src !== 'string' || src === '') return image
  return (
    <>
      <button
        aria-label={alt ? `放大图片：${alt}` : '放大图片'}
        className="block w-fit max-w-full cursor-zoom-in rounded-sm ui-focus"
        onClick={() => setOpen(true)}
        type="button"
      >
        {image}
      </button>
      <MediaLightbox
        media={open ? { kind: 'image', name: alt || '图片', url: src } : null}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** `<video>` 没写 src 时取第一个 `<source>` 的地址。 */
const firstSourceOf = (node: ExtraProps['node']) => {
  for (const child of node?.children ?? []) {
    if (child.type !== 'element' || child.tagName !== 'source') continue
    const src = child.properties['src']
    if (typeof src === 'string' && src !== '') return src
  }
  return undefined
}

/** 正文视频换成共享播放器，放大进灯箱。只取地址、封面与循环：文档里的 controls、muted、宽高都不带进 video。 */
function MarkdownVideo({ loop, node, poster, src }: ComponentProps<'video'> & ExtraProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [expanded, setExpanded] = useState<LightboxMedia | null>(null)
  const url = typeof src === 'string' && src !== '' ? src : firstSourceOf(node)
  if (url === undefined) return null
  return (
    <>
      <VideoPlayer
        className="w-fit max-w-full"
        label="视频"
        loop={loop}
        onExpand={(at) => setExpanded({ kind: 'video', name: '视频', poster, startAt: at, url })}
        poster={poster}
        ref={videoRef}
        src={url}
        videoClassName="size-auto max-w-full"
      />
      <MediaLightbox
        media={expanded}
        onClose={(at) => {
          setExpanded(null)
          if (at !== undefined && videoRef.current !== null) videoRef.current.currentTime = at
        }}
      />
    </>
  )
}

/**
 * 标签到组件的映射放在模块级：react-markdown 每次渲染都按它取组件类型，渲染里新建的映射会让 React
 * 认作换了组件、卸掉重挂对应节点，宿主每重渲染一次正文段落就整块重建，选中的文字随之丢失。
 */
const COMPONENTS: Components = {
  a: ({ children, href }) => (
    <a
      className="text-chat-link-text no-underline decoration-chat-link-border underline-offset-2 hover:underline"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      <InsideLinkContext value>{children}</InsideLinkContext>
    </a>
  ),
  // 代码块由 pre → CodeBlock 读取语言与文本自行渲染，这里只会渲染到行内代码。
  code: ({ children }) => <code className={CODE_INLINE}>{children}</code>,
  em: ({ children }) => <em className="italic">{children}</em>,
  // 正文标题使用 title 字阶；页面标题层级留给宿主。
  h1: ({ children }) => (
    <h3 className="border-b-[0.5px] border-chat-hairline pb-1 text-title font-semibold">
      {children}
    </h3>
  ),
  h2: ({ children }) => <h4 className="text-title font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="text-body font-semibold">{children}</h5>,
  hr: () => <hr className="border-chat-hairline" />,
  img: MarkdownImage,
  // 播放器是块级容器，放不进 <p>：同一行写的 <video> 会落在段落里，这时段落改用 div。
  p: ({ children, node }) =>
    node?.children.some((child) => child.type === 'element' && child.tagName === 'video') ? (
      <div>{children}</div>
    ) : (
      <p>{children}</p>
    ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">{children}</table>
    </div>
  ),
  td: ({ children }) => <td className={CELL}>{children}</td>,
  th: ({ children }) => <th className={cn(CELL, 'bg-chat-chip-bg font-semibold')}>{children}</th>,
  video: MarkdownVideo,
}

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm]
const REHYPE_PLUGINS: Options['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, SANITIZE]]

type MarkdownProps = {
  text: string
  className?: string
}

/** 聊天回复与工作区文档共用同一套排版；块间距由 .md-body 统一定义。 */
export function Markdown({ className, text }: MarkdownProps) {
  return (
    <div className={cn('md-body text-body leading-relaxed text-chat-message-text', className)}>
      <ReactMarkdown
        components={COMPONENTS}
        rehypePlugins={REHYPE_PLUGINS}
        remarkPlugins={REMARK_PLUGINS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
