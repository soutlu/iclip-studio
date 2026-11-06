import { createContext, use, useRef, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { VideoPlayer } from '@/shared/ui/video-player'
import { CodeBlock } from './code-block'

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

const InsideLinkContext = createContext(false)

type MarkdownImageProps = ComponentProps<'img'> & {
  thumbnail?: boolean
}

function MarkdownImage({ alt, height, onError, src, thumbnail, title, width }: MarkdownImageProps) {
  const inLink = use(InsideLinkContext)
  const [open, setOpen] = useState(false)
  const image = (
    <img
      alt={alt ?? ''}
      className={
        thumbnail
          ? 'block h-20 w-auto max-w-40 object-cover'
          : 'block h-auto max-h-80 w-auto max-w-full object-contain'
      }
      height={height}
      onError={onError}
      src={src}
      title={title}
      width={width}
    />
  )
  if (inLink || typeof src !== 'string' || src === '') return image
  return (
    <>
      <button
        aria-label={alt ? `放大图片：${alt}` : '放大图片'}
        className={cn(
          'cursor-zoom-in rounded-sm ui-focus',
          thumbnail ? 'inline-block overflow-hidden align-middle' : 'block w-fit max-w-full',
        )}
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

const IMAGE_URL = /^https?:\/\/[^?#\s]+\.(?:jpe?g|png|webp|gif|avif)(?:[?#]\S*)?$/i

const bareImageUrlOf = (node: ExtraProps['node'], href: string | undefined) => {
  if (href === undefined || !IMAGE_URL.test(href)) return undefined
  const [only, ...rest] = node?.children ?? []
  return rest.length === 0 && only?.type === 'text' && only.value === href ? href : undefined
}

function MarkdownLink({ children, href, node }: ComponentProps<'a'> & ExtraProps) {
  const [failedSrc, setFailedSrc] = useState<string>()
  const imageUrl = bareImageUrlOf(node, href)
  if (imageUrl !== undefined && imageUrl !== failedSrc) {
    return <MarkdownImage onError={() => setFailedSrc(imageUrl)} src={imageUrl} thumbnail />
  }
  return (
    <a
      className="text-chat-link-text no-underline decoration-chat-link-border underline-offset-2 hover:underline"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      <InsideLinkContext value>{children}</InsideLinkContext>
    </a>
  )
}

const firstSourceOf = (node: ExtraProps['node']) => {
  for (const child of node?.children ?? []) {
    if (child.type !== 'element' || child.tagName !== 'source') continue
    const src = child.properties['src']
    if (typeof src === 'string' && src !== '') return src
  }
  return undefined
}

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

const COMPONENTS: Components = {
  a: MarkdownLink,
  code: ({ children }) => <code className={CODE_INLINE}>{children}</code>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => (
    <h3 className="border-b-[0.5px] border-chat-hairline pb-1 text-title font-semibold">
      {children}
    </h3>
  ),
  h2: ({ children }) => <h4 className="text-title font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="text-body font-semibold">{children}</h5>,
  hr: () => <hr className="border-chat-hairline" />,
  img: MarkdownImage,
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

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkBreaks]
const REHYPE_PLUGINS: Options['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, SANITIZE]]

type MarkdownProps = {
  text: string
  className?: string
}

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
