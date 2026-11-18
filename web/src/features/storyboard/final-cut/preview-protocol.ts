import { z } from 'zod'

/**
 * 编辑器和预览页之间的消息。预览页在预览域名下，final-cut 在它里面运行；两边只靠 `postMessage` 通信，
 * 收到的每条消息都先按这里校验，不合规的丢掉。final-cut 里的脚本和预览页同源、能伪造预览页的消息，
 * 所以编辑器收到的消息里只有数字和布尔值，只当数据用。
 */

/** 预览页在预览域名下的路径；令牌写在 `#` 后面，不进请求和来源页地址。 */
export const PREVIEW_PAGE_PATH = '/final-cut-preview.html'

export const previewPageUrl = (origin: string, token: string): string =>
  `${origin}${PREVIEW_PAGE_PATH}#${encodeURIComponent(token)}`

const zSeconds = z.number().nonnegative()

const zSeq = z.number().int().nonnegative()

/** 画布上的一个矩形（像素）。 */
const zRect = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})

/**
 * 画面上的一层在哪（见 canvas-layers.ts 的 `CanvasLayer`）：挂在哪个宿主下（宿主的 `data-hf-id`，主文件里的是
 * null）、选择器、第几个匹配。
 */
const zLayerRef = z.strictObject({
  scope: z.string().nullable(),
  selector: z.string(),
  index: z.number().int().nonnegative(),
})

/** 行内样式（CSS 的写法）或属性：null 是去掉。 */
const zValues = z.record(z.string(), z.string().nullable())

/** 一层在画布上的样子：中心、宽高（像素）和角度（度，顺时针）。 */
const zFrame = z.strictObject({
  cx: z.number(),
  cy: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  angle: z.number(),
})

/**
 * 量出来的一层：画布上的样子 `frame`；布局宽高 `width`、`height`（不算变换）；父元素里一像素在画布上的样子
 * `parent`（2×2 线性变换）；它自己的 `rotate`（度）；变换里有没有位移 `translating`；是不是行内元素
 * `inline`；父元素的弹性方向 `flex`（0 不是弹性布局、1 横排、2 竖排）；三样能不能改，和不能改时的原因
 * `refusal`（见 layer-abilities.ts）。
 */
const zMeasure = z.strictObject({
  frame: zFrame,
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  parent: z.strictObject({ a: z.number(), b: z.number(), c: z.number(), d: z.number() }),
  rotate: z.number(),
  translating: z.boolean(),
  inline: z.boolean(),
  flex: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  move: z.boolean(),
  resize: z.boolean(),
  turn: z.boolean(),
  refusal: z.number().int().min(0).max(5),
})

/** 引擎的一条补丁（JSON Patch 的 add、remove、replace）。 */
const zPatchOp = z.strictObject({
  op: z.enum(['add', 'remove', 'replace']),
  path: z.string(),
  value: z.unknown().optional(),
})

/** 编辑器发给预览页的命令。 */
export const zPreviewCommand = z.discriminatedUnion('type', [
  /**
   * 换上一份 final-cut：`html` 是整份预览文档，`runtimeSrc` 是预览域名下的运行库地址，`captions` 是放进文档里的
   * 字幕场景文件（没有字幕场景时不给）。`seq` 和 `patch` 的共用一个计数，是这是编辑器发给这个预览页的第几份
   * final-cut。
   */
  z.strictObject({
    type: z.literal('load'),
    html: z.string(),
    runtimeSrc: z.string(),
    captions: z.string().optional(),
    seq: zSeq,
  }),
  /**
   * 把一步编辑的补丁直接打进正在播的那一份：`patches` 是主文件的，`captions` 是字幕场景的（没有时不给），先打
   * 主文件的；`fonts` 是字体块里新的中文字体规则（`<style>` 的内容，没变时不给），打补丁之前先换上。`seq` 要正好
   * 是预览页上一份的下一个，对不上或打不进去时预览页报 `needsLoad`。
   */
  z.strictObject({
    type: z.literal('patch'),
    seq: zSeq,
    patches: z.array(zPatchOp),
    captions: z.array(zPatchOp).optional(),
    fonts: z.string().optional(),
    /**
     * 组件文件里改了的层：预览里这份组件是从工程里取的（不经副本会话），直接把这一层的行内样式、属性改成这样
     * （null 是去掉）。在主文件、字幕场景的补丁之后改；改完按 `data-x` / `data-y` 重新摆一次（见 SDK 的
     * `moveElement`）。
     */
    layers: z
      .array(z.strictObject({ ref: zLayerRef, styles: zValues, attributes: zValues }))
      .optional(),
  }),
  /** final-cut 没有内容了：停下，正在加载的那份不再换上来。 */
  z.strictObject({ type: z.literal('unload') }),
  z.strictObject({ type: z.literal('play') }),
  z.strictObject({ type: z.literal('pause') }),
  /** 停下并跳到 final-cut 的第 `ms` 毫秒；`seq` 是这是编辑器发给这个预览页的第几次跳转。 */
  z.strictObject({ type: z.literal('seek'), ms: z.number().nonnegative(), seq: zSeq }),
  z.strictObject({
    type: z.literal('playback'),
    rate: z.number().positive(),
    muted: z.boolean(),
    loop: z.boolean(),
  }),
  /** final-cut 画布的尺寸。 */
  z.strictObject({
    type: z.literal('size'),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  /** 重新加载播放头所在、加载失败的那段视频。 */
  z.strictObject({ type: z.literal('retry') }),
  /**
   * 画面上的层（见 canvas-layers.ts）：之后的 `watch`、`pick`、`draft` 按它在这张表里的位置说是哪一层。`count` 是
   * 源文件里这个选择器一共几个匹配，画面里数出来不一样时这一层当成脚本生成的。
   */
  z.strictObject({
    type: z.literal('layers'),
    entries: z.array(zLayerRef.extend({ count: z.number().int().nonnegative() })),
  }),
  /**
   * 要量的层（`layers` 表里的位置）：预览页量出它们报 `measured`，之后换了一份、打了补丁、播到别处、字体加载好
   * 以后变了时带着这个 `seq` 再报。
   */
  z.strictObject({ type: z.literal('watch'), seq: zSeq, layers: z.array(zSeq) }),
  /** 画布上 (`x`, `y`) 处从上往下能选中的层（规则见运行库的 `pointerTargets`），报 `picked`。 */
  z.strictObject({ type: z.literal('pick'), seq: zSeq, x: z.number(), y: z.number() }),
  /**
   * 拖动中先把正在播的那一份里的一层（`layers` 表里的位置）摆成这样，不经副本会话：行内样式改成 `styles`，
   * 位移在拖动开始时的上面加 `move`（父元素里的像素）。`pin` 时再挪一下让它的中心回到拖动开始时的地方（缩放），
   * 报 `drafted`。
   */
  z.strictObject({
    type: z.literal('draft'),
    seq: zSeq,
    layer: zSeq,
    move: z.strictObject({ x: z.number(), y: z.number() }),
    styles: zValues,
    pin: z.boolean(),
  }),
  /**
   * 拖动结束：`keep` 时留着摆好的样子（接着提交，补丁写的是同样的值），不然摆回拖动开始时的样子。
   */
  z.strictObject({ type: z.literal('draftEnd'), layer: zSeq, keep: z.boolean() }),
  /**
   * 原地改字：在片段 `id` 里找画布上 (`x`, `y`) 处的文字字段（`data-var-text` 是 `fields` 里的一个；一句字幕自己就是
   * 这样的字段），找到了先藏起来（编辑器在上面放自己的输入框），报 `textTarget`。
   */
  z.strictObject({
    type: z.literal('editText'),
    seq: zSeq,
    id: z.string(),
    x: z.number(),
    y: z.number(),
    fields: z.array(z.string()),
  }),
  /** 改完字：藏起来的文字显示回来；`text` 不是 null 时先换成它，等新的一份换上来之前不闪回旧字。 */
  z.strictObject({ type: z.literal('endText'), text: z.string().nullable() }),
])

export type PreviewCommand = z.infer<typeof zPreviewCommand>

export type LayerRef = z.infer<typeof zLayerRef>
export type LayerFrame = z.infer<typeof zFrame>
export type LayerMeasure = z.infer<typeof zMeasure>

/** 预览页发给编辑器的消息。 */
export const zPreviewEvent = z.discriminatedUnion('type', [
  /** 预览页确认了应用的来源，开始收命令。 */
  z.strictObject({ type: z.literal('ready') }),
  /** 第 `seq` 份 final-cut 加载好、换了上来；`duration` 是它的秒数。 */
  z.strictObject({ type: z.literal('loaded'), duration: zSeconds, seq: zSeq }),
  /** 第 `seq` 份的补丁打进了正在播的那一份；`duration` 是打完以后的秒数。 */
  z.strictObject({ type: z.literal('patched'), duration: zSeconds, seq: zSeq }),
  /** 第 `seq` 份的补丁没有打（序号对不上、要改的元素不在、打的时候出错），要整份重新加载。 */
  z.strictObject({ type: z.literal('needsLoad'), seq: zSeq }),
  /**
   * 播放到 final-cut 的第 `ms` 毫秒；`seq` 是报这个时刻时预览页处理到的那次跳转。编辑器跳转时自己先把播放头
   * 放过去，跳转之前报出、还在路上的时刻要丢掉，不然播放头会先跳回去再过来。跳转以后到再次播放（或换上新的
   * 播放器）之前不报，这期间播放头由编辑器定。
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
  /** 各视频片段已缓冲的部分，换算成 final-cut 里的秒数。 */
  z.strictObject({
    type: z.literal('buffered'),
    spans: z.array(z.strictObject({ start: zSeconds, end: zSeconds })),
  }),
  /** final-cut 里的视频都停止了下载。 */
  z.strictObject({ type: z.literal('mediaSettled') }),
  /** 播放头所在的那段视频是否加载失败。 */
  z.strictObject({ type: z.literal('clipFailed'), failed: z.boolean() }),
  /** 第 `seq` 次 `watch` 要量的各层，和它的 `layers` 一一对应；画面里找不到、没显示的是 null。 */
  z.strictObject({ type: z.literal('measured'), seq: zSeq, items: z.array(zMeasure.nullable()) }),
  /**
   * 第 `seq` 次 `pick` 那一处从上往下能选中的层：`layer` 是它在 `layers` 表里的位置（表里没有、或者数不对，是
   * 脚本生成的，-1），`owner` 是挂着它的宿主在表里的位置（主文件里的、没有时 -1），`measure` 是量出来的它。
   */
  z.strictObject({
    type: z.literal('picked'),
    seq: zSeq,
    stack: z.array(
      z.strictObject({
        layer: z.number().int().min(-1),
        owner: z.number().int().min(-1),
        measure: zMeasure,
      }),
    ),
  }),
  /** 第 `seq` 次 `draft` 以后这一层的位移在拖动开始时的上面加了多少（父元素里的像素，含挪回中心的那一下）。 */
  z.strictObject({ type: z.literal('drafted'), seq: zSeq, x: z.number(), y: z.number() }),
  /**
   * 第 `seq` 次 `editText` 找到的文字：`field` 是它在 `fields` 里的第几个（找不到是 -1），框是它在画布上的位置，
   * `fontSize` 是它在画布上的字号（像素，算上了缩放）。
   */
  z.strictObject({
    type: z.literal('textTarget'),
    seq: zSeq,
    field: z.number().int().min(-1),
    ...zRect.shape,
    fontSize: z.number().nonnegative(),
  }),
])

export type PreviewEvent = z.infer<typeof zPreviewEvent>
