# ADR-0009：AI 导演不导出分镜，出片在制作页上按工程文件拼请求

- 状态：已接受（2026-10-07）
- 取代 ADR-0007 第 6 条；第 5 条的「原样照搬、不换算时间」改在出片时执行。
- 影响：[CONTEXT.md](../CONTEXT.md) 的「工程文件」词条、[architecture.md](../architecture.md) 的 `iclip_studio` 说明、[contract/conventions.md](../../contract/conventions.md) 的工作区文件写回与制作页；后端 [prompts.py](../../server/src/iclip/capabilities/iclip_studio/film/prompts.py) 的 `video_row`、分镜文件的行 [shot_document.py](../../server/src/iclip/capabilities/shot_document.py)；前端分镜文件的读法 [shot-document.ts](../../web/src/features/storyboard/shot-document.ts)。

## 背景

ADR-0007 让工程文件单向导出成 `video_shot.json`，人在分镜页上出片。分镜页上换图、改字只改分镜文件，回不到工程文件；AI 导演再导出一次，页面上的修改就被盖掉。制作页直接读写工程文件与运行文件，能改字、换图、生成图，分镜页上能做的它都覆盖了。比较过的方案：继续导出，导出前比对分镜文件，有页面上的修改就不盖；导出，并把分镜页的修改同步回工程文件；不导出，出片也放在制作页上。

## 决策

1. **不导出分镜。** 去掉 `export_shots`。AI 导演的对话里只有工程文件与运行文件，人在制作页上看和改。
2. **出片时现拼请求。** 点出片时后端按当下的两个文件拼这一组：一个 `Storyboard` 是一组，镜号是组号，参考图只带现在有图的，镜头时间原样照搬；生成记录的 `metadata.film_node` 是视频节点名。文件里写的模型只是出片栏的默认，人改选不写回。
3. **分镜文件去掉镜头组的 `model`。** 它只为导出而加，导出去掉后没有写它的一方。这个字段没进过发布版本，不留兼容。

## 取舍

- **接受**：AI 导演的对话不再有分镜页。制作页复用分镜页的组件，两页各自接线。
- **接受**：开发环境里导出过的、带 `model` 的分镜文件，分镜页读不出，写回也被拒。
- **不做**：导出前比对分镜文件。两份文件并存时，人要分清在哪边改才算数；只留工程文件就没有这个问题。
- **不做**：把拼好的出片请求存成文件。请求每次按当下的两个文件现拼，与生图同一种做法。
