# vendor：HyperFrames Studio 时间线与画面吸附纯算法

本目录代码移植自 [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) 的 `packages/studio/src`，基准对齐到标签 `v0.8.168`（提交 `6e1f9ee1`），开源许可证见 [LICENSE](LICENSE)（Apache-2.0）。根据 [ADR-0003](../../../../../../../docs/adr/0003-whole-film-hyperframes.md) 与 [ADR-0008](../../../../../../../docs/adr/0008-final-cut-workspace-project.md)，本项目不直接安装 `@hyperframes/studio` UI 包，仅按需摘录其纯计算逻辑。

为了保持源文件内部 `import` 路径不变，本目录保持与上游一致的目录结构。每个文件头部注有来源、许可证与裁剪说明；除下表列出的裁剪外，其余代码与上游逐字一致。

## 收录文件清单

| 文件路径 | 引入方式 | 用途与裁剪说明 |
|---|---|---|
| `utils/rounding.ts`、`player/lib/time.ts` | 全文引入 | 时间与数值舍入基础工具 |
| `player/components/timelineSnapping.ts` | 全文引入 | 时间线拖拽吸附计算（对齐播放头、片段边界、音乐拍点与时间刻度） |
| `player/components/timelineZoom.ts` | 全文引入 | 时间线缩放档位与滑杆换算；缩放到选中的片段（`positiveClipSpan`、`zoomToSelectedClips` 及其常量与类型）取自 `v0.9.31`（提交 `cf900546`） |
| `player/components/timelineLayout.ts`、`automationLaneHeight.ts` | 全文引入 | 时间与像素坐标互转、轨道行高计算 |
| `player/components/timelineGaps.ts` | 全文引入 | 主轨波纹删除后收紧空隙（`resolveAllTrackGaps`） |
| `player/components/timelineEditing.ts` | 部分摘录 | 仅保留 `resolveTimelineMove`（移除 z-index 分支）、`resolveTimelineResize` 及两个数值格式化函数 |
| `player/components/timelineGroupEditing.ts` | 部分摘录 | 保留前 175 行，移除多选分组修剪接线，内联 `clampPlaybackRate` 并导出 `DEFAULT_TIMELINE_MIN_DURATION` |
| `player/components/timelineCollision.ts` | 全文引入 | 取自 `v0.9.31`（提交 `cf900546`）：同行就近落位（`resolveNearestFreeStart`）、片段只落在所属分区（`resolveZoneDropPlacement`、`clampTrackToZone`、`isInsertAllowedForZone`）与区间重叠判断；注释附加 `design-allow` 避免设计门禁误判上游问题编号 |
| `player/components/timelineStackingSync.ts` | 全文引入 | 画面区片段跨行移动后重算叠放顺序（`computeStackingPatches`） |
| `components/editor/snapEngine.ts` | 全文引入 | 预览画布上拖拽元素的中心线与四边吸附参考线计算 |
| `components/editor/audioInspectorInput.ts` | 全文引入 | 取自 `v0.9.31`（提交 `cf900546`）：属性面板中增益、速度与秒数输入的解析 |
| `components/editor/propertyPanelHelpers.ts` | 部分摘录 | 取自 `v0.9.31`（提交 `cf900546`）：仅保留 `formatNumericValue`（速度两位小数格式化） |
| `player/components/automationLaneGeometry.ts` | 部分摘录 | 取自 `v0.9.31`（提交 `cf900546`）的 `toUnit`、`fromUnit`（速度滑杆对数换算），以及 `v0.9.59`（提交 `028ab755`）的 `POINT_MERGE_SEC`、`MIN_POINT_GAP_SEC`（音量关键帧合并距离与最小间隔） |
| `components/editor/clipAudioClock.ts` | 部分摘录 | 取自 `v0.9.59`（提交 `028ab755`）：移除 `readClipClock`，保留按入点、速度与时长计算片段实际播放音频区间的逻辑 |
| `components/editor/useFxCarveNodes.ts` | 部分摘录 | 取自 `v0.9.59`（提交 `028ab755`）：移除文件拉取与解码部分，保留将自动压低分析结果转为效果链节点与自动化曲线的 `mintCarveNodes`、`carveLanes` |
| `components/editor/carveOutput.ts` | 部分摘录 | 取自 `v0.9.59`（提交 `028ab755`）：仅保留 `withoutCarveLanes`（重算前清理旧的自动压低曲线） |
| `player/store/playerStore.ts`、`player/lib/timelineClipIndex.ts` | 本地最小类型替身 | 仅声明上述算法文件依赖的最小 TypeScript 类型（`ZoomMode`、`TimelineTimeRange`、`TimelineElement`） |

## 工具链与维护边界

- **独立类型检查**：本目录通过独立的 [tsconfig.vendor-hyperframes.json](../../../../../../tsconfig.vendor-hyperframes.json) 进行类型检查（配合上游源码放宽了 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`），并在 ESLint、Prettier 与 knip 中排除。
- **不在本目录写业务逻辑**：本项目自有的 `final-cut` 编辑规则写在外层目录中并配有单测，不要直接修改本 `vendor/` 目录下的算法文件。升级上游版本时，请对照上表逐个文件同步并保留头部说明，切勿整目录直接覆盖。
