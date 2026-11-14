import { z } from 'zod'

/**
 * 编辑器和预览页之间的消息。预览页在预览域名下，成片在它里面运行；两边只靠 `postMessage` 通信，
 * 收到的每条消息都先按这里校验，不合规的丢掉。成片里的脚本和预览页同源、能伪造预览页的消息，
 * 所以编辑器收到的消息里只有数字和布尔值，只当数据用。
 */

/** 预览页在预览域名下的路径；令牌写在 `#` 后面，不进请求和来源页地址。 */
export const PREVIEW_PAGE_PATH = '/whole-film-preview.html'

export const previewPageUrl = (origin: string, token: string): string =>
  `${origin}${PREVIEW_PAGE_PATH}#${encodeURIComponent(token)}`

const zSeconds = z.number().nonnegative()

const zSeq = z.number().int().nonnegative()

/** 编辑器发给预览页的命令。 */
export const zPreviewCommand = z.discriminatedUnion('type', [
  /** 换上一份成片：`html` 是整份预览文档，`runtimeSrc` 是预览域名下的运行库地址。 */
  z.strictObject({ type: z.literal('load'), html: z.string(), runtimeSrc: z.string() }),
  /** 成片没有内容了：停下，正在加载的那份不再换上来。 */
  z.strictObject({ type: z.literal('unload') }),
  z.strictObject({ type: z.literal('play') }),
  z.strictObject({ type: z.literal('pause') }),
  /** 停下并跳到成片的第 `ms` 毫秒；`seq` 是这是编辑器发给这个预览页的第几次跳转。 */
  z.strictObject({ type: z.literal('seek'), ms: z.number().nonnegative(), seq: zSeq }),
  z.strictObject({
    type: z.literal('playback'),
    rate: z.number().positive(),
    muted: z.boolean(),
    loop: z.boolean(),
  }),
  /** 成片画布的尺寸。 */
  z.strictObject({
    type: z.literal('size'),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  /** 重新加载播放头所在、加载失败的那段视频。 */
  z.strictObject({ type: z.literal('retry') }),
])

export type PreviewCommand = z.infer<typeof zPreviewCommand>

/** 预览页发给编辑器的消息。 */
export const zPreviewEvent = z.discriminatedUnion('type', [
  /** 预览页确认了应用的来源，开始收命令。 */
  z.strictObject({ type: z.literal('ready') }),
  /** 一份成片加载好、换了上来；`duration` 是它的秒数。 */
  z.strictObject({ type: z.literal('loaded'), duration: zSeconds }),
  /**
   * 播放到成片的第 `ms` 毫秒；`seq` 是报这个时刻时预览页处理到的那次跳转。编辑器跳转时自己先把播放头
   * 放过去，跳转之前报出、还在路上的时刻要丢掉，不然播放头会先跳回去再过来。
   */
  z.strictObject({
    type: z.literal('time'),
    ms: z.number().int().nonnegative(),
    seq: zSeq,
  }),
  /** 是否算在播放：等数据时也算；暂停、跳转、播完都是 false。 */
  z.strictObject({ type: z.literal('playing'), playing: z.boolean() }),
  /** 播放头所在的视频片段数据不够，正在等。 */
  z.strictObject({ type: z.literal('buffering'), buffering: z.boolean() }),
  /** 各视频片段已缓冲的部分，换算成成片里的秒数。 */
  z.strictObject({
    type: z.literal('buffered'),
    spans: z.array(z.strictObject({ start: zSeconds, end: zSeconds })),
  }),
  /** 成片里的视频都停止了下载。 */
  z.strictObject({ type: z.literal('mediaSettled') }),
  /** 播放头所在的那段视频是否加载失败。 */
  z.strictObject({ type: z.literal('clipFailed'), failed: z.boolean() }),
])

export type PreviewEvent = z.infer<typeof zPreviewEvent>
