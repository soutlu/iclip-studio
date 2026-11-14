import { createPreviewPage, type PreviewPage } from '@/features/storyboard/whole-film/preview-page'
import {
  PREVIEW_PAGE_PATH,
  zPreviewCommand,
  type PreviewCommand,
} from '@/features/storyboard/whole-film/preview-protocol'

/**
 * 嵌进编辑器的一个预览页替身。jsdom 不加载 iframe 的地址，跨来源的 postMessage 也会丢，
 * 所以这里接管 iframe 窗口的 postMessage，按浏览器的样子异步收发：编辑器发的命令按协议校验后记下，
 * 给编辑器的消息以这个 iframe 窗口和预览域名的身份派发。
 */
export type ServedPreviewPage = {
  frame: HTMLIFrameElement
  /** iframe 地址里的预览域名。 */
  origin: string
  /** 地址 `#` 后面的令牌。 */
  token: string
  /** 编辑器发来的命令，按收到的先后。 */
  commands: PreviewCommand[]
  /** 以预览页的身份给编辑器发一条消息；`data` 可以不合规，`from` 可以换掉来源或发送方。 */
  post: (data: unknown, from?: { origin?: string; source?: MessageEventSource | null }) => void
  /** 跑着真的预览页逻辑时放播放器的地方（在编辑器外面）；只记命令时是 null。 */
  mount: HTMLElement | null
}

type ServeOptions = {
  /** 跑真的预览页逻辑（播放器用测试替身），不跑时只记下命令。 */
  run: boolean
  /** 一嵌进来就报就绪；为 false 时由用例自己发 `{ type: 'ready' }`。 */
  ready?: boolean
}

/** 从现在起，嵌进页面的每个预览页都换成替身；`stop` 拆掉它们。 */
export const servePreviewPages = ({ run, ready = true }: ServeOptions) => {
  const pages: ServedPreviewPage[] = []
  const running: { page: PreviewPage; mount: HTMLElement }[] = []

  // 一次插进来的子树会出现在几条记录里，同一个 iframe 只接一次
  const attached = new WeakSet<HTMLIFrameElement>()
  const attach = (frame: HTMLIFrameElement) => {
    const target = frame.contentWindow
    const url = new URL(frame.getAttribute('src') ?? '', window.location.href)
    if (url.pathname !== PREVIEW_PAGE_PATH || target === null || attached.has(frame)) return
    attached.add(frame)
    const post: ServedPreviewPage['post'] = (data, from = {}) => {
      const source = from.source === undefined ? target : from.source
      setTimeout(() =>
        window.dispatchEvent(
          new MessageEvent('message', { data, origin: from.origin ?? url.origin, source }),
        ),
      )
    }
    const served: ServedPreviewPage = {
      frame,
      origin: url.origin,
      token: decodeURIComponent(url.hash.slice(1)),
      commands: [],
      post,
      mount: null,
    }
    let page: PreviewPage | null = null
    if (run) {
      const mount = document.createElement('div')
      document.body.append(mount)
      page = createPreviewPage(mount, (event) => post(event))
      running.push({ page, mount })
      served.mount = mount
    }
    target.postMessage = ((data: unknown, targetOrigin: string) => {
      // 来源对不上时浏览器直接丢掉
      if (targetOrigin !== url.origin) return
      const command = zPreviewCommand.parse(structuredClone(data))
      setTimeout(() => {
        served.commands.push(command)
        page?.handle(command)
      })
    }) as Window['postMessage']
    pages.push(served)
    if (ready) post({ type: 'ready' })
  }

  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement) attach(node)
        else if (node instanceof Element) node.querySelectorAll('iframe').forEach(attach)
      }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  return {
    pages,
    /** 最后嵌进来的那个预览页。 */
    latest: () => {
      const page = pages.at(-1)
      if (page === undefined) throw new Error('还没有嵌进预览页')
      return page
    },
    stop: () => {
      observer.disconnect()
      for (const { page, mount } of running.splice(0)) {
        page.dispose()
        mount.remove()
      }
    },
  }
}
