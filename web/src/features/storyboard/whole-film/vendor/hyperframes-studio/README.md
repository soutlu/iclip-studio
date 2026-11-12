# vendor：HyperFrames Studio 时间线与画面吸附纯算法

本目录代码移植自 [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) 的 `packages/studio/src`，基准对齐到标签 `v0.8.168`（提交 `6e1f9ee1`），开源许可证见 [LICENSE](LICENSE)（Apache-2.0）。根据 [ADR-0003](../../../../../../../docs/adr/0003-whole-film-hyperframes.md)，本项目不直接安装 `@hyperframes/studio` UI 包，仅按需摘录其纯计算逻辑。

为了保持源文件内部 `import` 路径不变，本目录保持与上游一致的目录结构。每个文件头部注有来源、许可证与裁剪说明；除下表列出的裁剪外，其余代码与上游逐字一致。

## 收录文件清单

| 文件路径 | 引入方式 | 用途与裁剪说明 |
|---|---|---|
| `utils/rounding.ts`、`player/lib/time.ts` | 全文引入 | 时间与数值舍入基础工具 |
| `player/components/timelineSnapping.ts` | 全文引入 | 时间线拖拽吸附计算（对齐播放头、片段边界、音乐拍点与时间刻度） |
| `player/components/timelineZoom.ts` | 全文引入 | 时间线缩放档位与滑杆换算 |
| `player/components/timelineLayout.ts`、`automationLaneHeight.ts` | 全文引入 | 时间与像素坐标互转、轨道行高计算 |
| `player/components/timelineGaps.ts` | 全文引入 | 画面轨自动收紧空隙（`resolveAllTrackGaps`） |
| `player/components/timelineEditing.ts` | 部分摘录 | 仅保留 `resolveTimelineMove`（移除 z-index 分支）、`resolveTimelineResize` 及两个数值格式化函数 |
| `player/components/timelineGroupEditing.ts` | 部分摘录 | 保留前 175 行，移除多选分组修剪接线，内联 `clampPlaybackRate` 并导出 `DEFAULT_TIMELINE_MIN_DURATION` |
| `player/components/timelineCollision.ts` | 部分摘录 | 仅保留特效块同行就近落位（`resolveNearestFreeStart`）、跨行新建轨道（`resolveInsertRow`）与区间重叠判断（`timeRangesOverlap`） |
| `player/components/timelineStackingSync.ts` | 全文引入 | 特效块跨行移动后重算叠放顺序（`computeStackingPatches`） |
| `components/editor/snapEngine.ts` | 全文引入 | 预览画布上拖拽元素的中心线与四边吸附参考线计算 |
| `player/store/playerStore.ts`、`player/lib/timelineClipIndex.ts` | 本地最小类型替身 | 仅声明上述算法文件依赖的最小 TypeScript 类型（`ZoomMode`、`TimelineTimeRange`、`TimelineElement`） |

## 工具链与维护边界

- **独立类型检查**：本目录通过独立的 [tsconfig.vendor-hyperframes.json](../../../../../../tsconfig.vendor-hyperframes.json) 进行类型检查（配合上游源码放宽了 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`），并在 ESLint、Prettier 与 knip 中排除。
- **不在本目录写业务逻辑**：本项目自有的成片编辑规则写在外层目录中并配有单测，不要直接修改本 `vendor/` 目录下的算法文件。升级上游版本时，请对照上表逐个文件同步并保留头部说明，切勿整目录直接覆盖。
