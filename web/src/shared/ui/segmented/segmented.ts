/**
 * 分段切换的材质：凹槽里浮起一个白块。共用 `ChipGroup` 的 `segmented` 变体和共用 `Tabs` 的 `segmented` 变体都引用
 * 这两串类，尺寸、内边距、间距和过渡由各组件自己给。
 *
 * - 槽：浅色是 surface-container-high 底加凹槽内阴影；深色下压成 control-well，比当前项暗，保持浮起的层次。
 * - 选项：悬停只加深文字（不可用的不加深）；当前项是 card 底、浮起投影加顶部高光、600 字重，深色下换成
 *   surface-container-high。圆角取槽圆角减去 2px 槽内边距，内外同心。
 */
export const SEGMENTED_TRACK =
  'rounded-control bg-surface-container-high shadow-control-well dark:bg-control-well'

export const SEGMENTED_ITEM =
  'rounded-[calc(var(--radius-control)-2px)] text-label font-medium text-on-surface-muted hover:not-aria-disabled:text-on-surface segment-current:bg-card segment-current:font-semibold segment-current:text-on-surface segment-current:shadow-[var(--shadow-pill),var(--shadow-specular)] dark:segment-current:bg-surface-container-high'
