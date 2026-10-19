# vendor：HyperFrames Studio 时间线与画面吸附纯逻辑

本目录照抄 [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) 的 `packages/studio/src`，对齐到 tag `v0.8.168`（提交 `6e1f9ee1`）。许可证见 [LICENSE](LICENSE)（Apache-2.0，上游未附 NOTICE）。不安装 `@hyperframes/studio` 包，见 [ADR-0003](../../../../../../../docs/adr/0003-whole-film-hyperframes.md)。

目录结构与上游相同，被抄文件的 import 行因此保持原样。每个文件开头三到八行是来源、许可与改动说明；去掉这几行后与上游逐字节一致，摘录文件只删不改（下表注明的除外）。

## 收录范围

| 文件                                                                              | 上游               | 说明                                                                                   |
| --------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `utils/rounding.ts`                                                               | 全文               | 上游没有对应测试                                                                       |
| `player/lib/time.ts`、`time.test.ts`                                              | 全文               |                                                                                        |
| `player/components/timelineSnapping.ts`、`.test.ts`                               | 全文               | 吸附到播放头、片段边界、拍点、刻度                                                     |
| `player/components/timelineZoom.ts`、`.test.ts`                                   | 全文               | 缩放档位与滑杆                                                                         |
| `player/components/timelineLayout.ts`、`automationLaneHeight.ts`                  | 全文               | 时间与像素换算、行几何                                                                 |
| `player/components/timelineLayout.test.ts`                                        | 删去部分用例       | 删去依赖未收录模块（`timelineRulerGeometry`、`timelineViewportGeometry`）的 4 个用例 |
| `player/components/timelineGaps.ts`、`.test.ts`                                   | 全文               | 整轨压实 `resolveAllTrackGaps`                                                         |
| `player/components/timelineEditing.ts`                                            | 摘录               | 只取 `resolveTimelineMove`（去掉 z-index 叠放分支及其可选入参、出参）、`resolveTimelineResize` 与两个数值格式化函数 |
| `player/components/timelineEditing.test.ts`                                       | 摘录               | 只留上述函数与分组移动、分组修剪的用例                                                 |
| `player/components/timelineGroupEditing.ts`                                       | 摘录（第 1–175 行） | 去掉多选分组修剪的接线；`clampPlaybackRate` 由 `@hyperframes/parsers` 的源码（`packages/parsers/src/mediaDuration.ts` 第 25–34 行）内联替代；`DEFAULT_TIMELINE_MIN_DURATION` 改为导出 |
| `player/components/timelineCollision.ts`                                          | 摘录               | 只取特效块落到行上最近的空位 `resolveNearestFreeStart`（及其三个小函数）、在行外开新行 `resolveInsertRow` 与 `timeRangesOverlap`，去掉分音画区与分组的落点代码；上游测试未收录 |
| `player/components/timelineStackingSync.ts`                                       | 全文               | 换行后只给被挪的块重排叠放 `computeStackingPatches`；`spansOverlap` 取已安装的 `@hyperframes/core`；上游测试未收录 |
| `components/editor/snapEngine.ts`、`.test.ts`                                     | 全文               | 画面上拖动的吸附与参考线；本仓只吸画面本身的中线与四边，不吸别的块                     |
| `player/store/playerStore.ts`、`player/lib/timelineClipIndex.ts`                  | 本仓替身           | 只声明被抄文件引用的类型：`ZoomMode`、`TimelineTimeRange` 照抄，`TimelineElement` 只留被读的字段 |

## 工具配置

- 类型检查走单独的 composite 项目 [tsconfig.vendor-hyperframes.json](../../../../../../tsconfig.vendor-hyperframes.json)，测试文件不做类型检查（同 transcript vendor）。上游只开 `strict`，这里只放宽上游源码实际触发的 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`。
- ESLint、Prettier、knip 都排除本目录；design-guard 照常扫描。
- 测试由本仓 Vitest 照常运行（`pnpm test -- whole-film`）。

## 维护边界

本仓的整片编辑规则写在[上级目录](../../editing/)，不改这里的文件。升级上游版本时，按上表逐个文件重新照抄、保留本仓的改动说明，再跑本目录测试；不直接覆盖整个目录。
