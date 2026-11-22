import { z } from 'zod'

/**
 * 编辑器与独立预览页之间的跨源 `postMessage` 协议。
 * 预览页运行在独立预览域名沙箱中，双方接收的每条消息均须先通过本文件 Schema 校验，不合规则丢弃；
 * 由于工程内的不可信脚本与预览页同源、可伪造上行消息，预览页发往编辑器的事件仅包含数值、布尔与受检字段名，一律只作纯数据消费。
 */

/** 预览页静态路径；签名令牌放在 URL `#` 片段中传递，避免进入服务端请求日志或 `Referer` 头。 */
export const PREVIEW_PAGE_PATH = '/final-cut-preview.html'

export const previewPageUrl = (origin: string, token: string): string =>
  `${origin}${PREVIEW_PAGE_PATH}#${encodeURIComponent(token)}`

const zSeconds = z.number().nonnegative()

const zSeq = z.number().int().nonnegative()

/** 画布像素矩形。 */
const zRect = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})

/** 图层定位标识（对应 canvas-layers.ts 的 `CanvasLayer`）：所属宿主的 `data-hf-id`（主文件顶层为 `null`）、稳定选择器与同名序号。 */
const zLayerRef = z.strictObject({
  scope: z.string().nullable(),
  selector: z.string(),
  index: z.number().int().nonnegative(),
})

/** CSS 行内样式或属性键值表（`null` 表示移除该项）。 */
const zValues = z.record(z.string(), z.string().nullable())

/** 画布上的图层旋转框：中心坐标、宽高（画布像素）与顺时针旋转角度（度）。 */
const zFrame = z.strictObject({
  cx: z.number(),
  cy: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  angle: z.number(),
})

/**
 * 图层实测几何与可编辑状态：
 * - `frame`：完整图层框；`visible`：叠加自身 `inset()`、溢出祖先与画布裁剪后的可见同角框（完全不可见时为 `null`，见 canvas-visible.ts）；
 * - `width` / `height`：未含变换的布局宽高；`parent`：父容器到画布的 2×2 线性变换；
 * - `rotate`：独立 `rotate` 角度；`translating`：`transform` 是否含平移分量；`inline`：是否为行内元素；`flex`：父容器弹性主轴（`0` 非弹性、`1` 横向、`2` 纵向）；
 * - `move` / `resize` / `turn` 与 `refusal`：三项手势可编辑标记及拒绝码（见 layer-abilities.ts）。
 */
const zMeasure = z.strictObject({
  frame: zFrame,
  visible: zFrame.nullable(),
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
  refusal: z.number().int().min(0).max(3),
})

/** 引擎 JSON Patch 单步操作（`add / remove / replace`）。 */
const zPatchOp = z.strictObject({
  op: z.enum(['add', 'remove', 'replace']),
  path: z.string(),
  value: z.unknown().optional(),
})

/** 编辑器下发给预览页的控制命令。 */
export const zPreviewCommand = z.discriminatedUnion('type', [
  /**
   * 整份加载工程：`html` 为组装后的预览文档，`runtimeSrc` 为同源运行库地址，`captions` 为内联字幕场景内容（无字幕时省略）；
   * `seq` 与 `patch` 共享递增序号。
   */
  z.strictObject({
    type: z.literal('load'),
    html: z.string(),
    runtimeSrc: z.string(),
    captions: z.string().optional(),
    seq: zSeq,
  }),
  /**
   * 增量热打补丁：`patches` 作用于主文件，`captions` 作用于字幕场景，`fonts` 为更新后的中文字体子集 `<style>` 文本（先行替换）；
   * `seq` 必须严格等于预览页当前序号加 1，否则或应用失败时预览页回传 `needsLoad` 触发整份重载。
   */
  z.strictObject({
    type: z.literal('patch'),
    seq: zSeq,
    patches: z.array(zPatchOp),
    captions: z.array(zPatchOp).optional(),
    fonts: z.string().optional(),
  }),
  /** 工程清空：暂停播放并丢弃后台正在加载的待切换播放器。 */
  z.strictObject({ type: z.literal('unload') }),
  z.strictObject({ type: z.literal('play') }),
  z.strictObject({ type: z.literal('pause') }),
  /** 暂停并定位至第 `ms` 毫秒；`seq` 为递增跳转序号。 */
  z.strictObject({ type: z.literal('seek'), ms: z.number().nonnegative(), seq: zSeq }),
  z.strictObject({
    type: z.literal('playback'),
    rate: z.number().positive(),
    muted: z.boolean(),
    loop: z.boolean(),
  }),
  /** 更新画布宽高尺寸。 */
  z.strictObject({
    type: z.literal('size'),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  /** 重新加载当前播放头处加载失败的视频片段。 */
  z.strictObject({ type: z.literal('retry') }),
  /**
   * 同步可编辑图层表（见 canvas-layers.ts）：后续 `watch`、`pick`、`snap`、`draft` 均按表下标引用图层。
   * `count` 用于核对预览 DOM 同名匹配数一致；`host` 标识贴片/场景宿主（命中内部可视元素即归属整个宿主，拖拽草稿按宿主规则更新）。
   */
  z.strictObject({
    type: z.literal('layers'),
    entries: z.array(
      zLayerRef.extend({ count: z.number().int().nonnegative(), host: z.boolean() }),
    ),
  }),
  /** 订阅指定图层（表下标）的几何测量，结果及后续变更携带 `seq` 通过 `measured` 上报。 */
  z.strictObject({ type: z.literal('watch'), seq: zSeq, layers: z.array(zSeq) }),
  /** 查询画布坐标 (`x`, `y`) 处从上到下的可选中图层栈（见 preview-canvas.ts `unitsAt`），结果通过 `picked` 上报。 */
  z.strictObject({ type: z.literal('pick'), seq: zSeq, x: z.number(), y: z.number() }),
  /** 在首次 `draft` 前测量待移动图层（表下标）的初始联合外框及周围可吸附目标框，结果通过 `snapRects` 上报。 */
  z.strictObject({ type: z.literal('snap'), seq: zSeq, layers: z.array(zSeq) }),
  /**
   * 拖拽期间直接更新运行中 DOM 的实时草稿（不经 SDK 副本会话）：覆盖行内 `styles` 并在初始位移上叠加局部偏移 `move`；
   * `pin` 为真时（普通图层缩放）额外补偿中心漂移并通过 `drafted` 回传最终偏移。
   */
  z.strictObject({
    type: z.literal('draft'),
    seq: zSeq,
    layer: zSeq,
    move: z.strictObject({ x: z.number(), y: z.number() }),
    styles: zValues,
    pin: z.boolean(),
  }),
  /** 结束拖拽草稿：`keep` 为真时保留当前 DOM 状态等待正式补丁落位，为假时还原至拖拽前样式。 */
  z.strictObject({ type: z.literal('draftEnd'), layer: zSeq, keep: z.boolean() }),
  /**
   * 启动画布原地改字：在片段 `id` 内定位 (`x`, `y`) 处匹配 `fields` 的文字节点，隐藏原文字并通过 `textTarget` 回传位置与缩放后字号。
   */
  z.strictObject({
    type: z.literal('editText'),
    seq: zSeq,
    id: z.string(),
    x: z.number(),
    y: z.number(),
    fields: z.array(z.string()),
  }),
  /** 结束原地改字并恢复原文字显示；传入非空 `text` 时先行更新节点文本，避免新文档生效前闪回旧字。 */
  z.strictObject({ type: z.literal('endText'), text: z.string().nullable() }),
])

export type PreviewCommand = z.infer<typeof zPreviewCommand>

export type LayerRef = z.infer<typeof zLayerRef>
/** 图层表条目（见 `layers` 命令）。 */
export type LayerEntry = Extract<PreviewCommand, { type: 'layers' }>['entries'][number]
export type LayerFrame = z.infer<typeof zFrame>
export type LayerMeasure = z.infer<typeof zMeasure>

/** 预览页上报给编辑器的事件。 */
export const zPreviewEvent = z.discriminatedUnion('type', [
  /** 预览页完成应用来源核验，准备接收控制命令。 */
  z.strictObject({ type: z.literal('ready') }),
  /** 第 `seq` 版工程完成整份加载并切换上线，`duration` 为总时长（秒）。 */
  z.strictObject({ type: z.literal('loaded'), duration: zSeconds, seq: zSeq }),
  /** 第 `seq` 版增量补丁已应用，`duration` 为更新后总时长（秒）。 */
  z.strictObject({ type: z.literal('patched'), duration: zSeconds, seq: zSeq }),
  /** 第 `seq` 版增量补丁无法应用（序号失步、目标缺失或执行报错），请求编辑器整份重载。 */
  z.strictObject({ type: z.literal('needsLoad'), seq: zSeq }),
  /**
   * 上报当前播放进度 `ms`（毫秒）及最后处理的跳转序号 `seq`。
   * 在播时每帧报一次运行库时钟的时刻（值没变的帧不报）；停着时（暂停、缓冲等待、播完、跳转落定、换上播放器后）随播放器的时间更新上报。
   * 编辑器发起跳转后立即更新本地播放头并丢弃旧 `seq` 的在途时间帧；预览页在跳转后至下次开播（或切换播放器）前暂停上报，避免异步回执拉回播放头。
   */
  z.strictObject({
    type: z.literal('time'),
    ms: z.number().int().nonnegative(),
    seq: zSeq,
  }),
  /** 播放状态（缓冲等待期间仍为 `true`；暂停、跳转与播完为 `false`）。 */
  z.strictObject({ type: z.literal('playing'), playing: z.boolean() }),
  /** 当前播放头处视频片段是否正在缓冲等待数据。 */
  z.strictObject({ type: z.literal('buffering'), buffering: z.boolean() }),
  /** 各视频片段已缓冲区间在主时间线上的并集（秒）。 */
  z.strictObject({
    type: z.literal('buffered'),
    spans: z.array(z.strictObject({ start: zSeconds, end: zSeconds })),
  }),
  /** 工程内全部视频元素均已结束网络加载。 */
  z.strictObject({ type: z.literal('mediaSettled') }),
  /** 当前播放头处的视频片段是否加载报错。 */
  z.strictObject({ type: z.literal('clipFailed'), failed: z.boolean() }),
  /** 对应第 `seq` 次 `watch` 订阅各图层的测量结果（未找到或未显示时对应项为 `null`）。 */
  z.strictObject({ type: z.literal('measured'), seq: zSeq, items: z.array(zMeasure.nullable()) }),
  /**
   * 对应第 `seq` 次 `pick` 的从上到下命中图层栈：`layer` 为图层表下标，`field` 为指针下绑定的可填项名（`data-var-text`，未绑定为 `null`）。
   */
  z.strictObject({
    type: z.literal('picked'),
    seq: zSeq,
    stack: z.array(
      z.strictObject({ layer: zSeq, field: z.string().nullable(), measure: zMeasure }),
    ),
  }),
  /**
   * 对应第 `seq` 次 `snap` 的吸附矩形（画布像素，均已按自身 `inset()` 收窄）：
   * `moving` 为待移图层的联合外框（均未找到时为 `null`），`targets` 为其他候选图层与可见贴片/场景宿主外框。
   */
  z.strictObject({
    type: z.literal('snapRects'),
    seq: zSeq,
    moving: zRect.nullable(),
    targets: z.array(zRect),
  }),
  /** 对应第 `seq` 次 `draft` 应用后的最终局部像素偏移（含中心锚定补偿）。 */
  z.strictObject({ type: z.literal('drafted'), seq: zSeq, x: z.number(), y: z.number() }),
  /** 对应第 `seq` 次 `editText` 的定位结果：`field` 为 `fields` 下标（未命中为 `-1`），附带画布边框与缩放后字号。 */
  z.strictObject({
    type: z.literal('textTarget'),
    seq: zSeq,
    field: z.number().int().min(-1),
    ...zRect.shape,
    fontSize: z.number().nonnegative(),
  }),
])

export type PreviewEvent = z.infer<typeof zPreviewEvent>
