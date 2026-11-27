# ADR-0008：剪辑工程改为工作区 final-cut HTML 目录并在独立预览域名沙箱运行

- **状态**：已接受（2026-11-15）
- **取代与沿用**：取代 [ADR-0003](0003-whole-film-hyperframes.md) 第 1、3、5–7 条；沿用其第 2、4 条（外置组件库、摘录 Studio 纯算法、独立 Node 渲染服务与异步导出下载归因）
- **影响范围**：[CONTEXT.md](../CONTEXT.md)；[contract/openapi.json](../../contract/openapi.json)；[contract/conventions.md](../../contract/conventions.md) §2、§6；[architecture.md](../architecture.md)；[deploy.md](../deploy.md)；[frontend-implementation.md](../../web/docs/frontend-implementation.md)

## 背景

[ADR-0003](0003-whole-film-hyperframes.md) 在后端维护了一套固定结构的 JSON 成片草稿（`WholeFilmDocument`，限制 2 分钟、固定四轨、画面轨强制首尾相接），每次预览与导出再由 `composition/` 动态转换为 HTML。随着 Agent 需要直接读写剪辑工程、组件允许携带自定义脚本与多级图层，以及多轨自由剪辑、智能调音和多语言配音导出的引入，固定 JSON 草稿成了表达能力的瓶颈；同时，一旦允许工作区工程携带脚本，直接在主应用域名下预览会暴露用户的登录 Cookie。

## 决策

1. **直接以工作区 `final-cut/` HTML 目录作为唯一事实源**：移除后端成片草稿表与 2 分钟时长限制。正在剪辑的工程与工作台页签统一命名为 `final-cut`（界面固定小写带连字符），「成片」仅指渲染导出的 MP4 产物。`final-cut/index.html` 是唯一主时间线，编辑器通过 `@hyperframes/sdk` 直接读写工程文件，后端不解析或改写工程结构，仅在发起导出时提取素材地址用于血缘归因。
2. **组件拷入工程私有化，公共依赖只增不删**：组件库选用条目（界面分称「元素」与「模板」）时，将其专有文本文件按原路径拷入 `final-cut/` 归该工程独立持有，画布内层编辑直接写回所属工程文件；运行库、动画库与字体文件统一放在跨版本共享的 `vendor/` 目录（带版本或哈希路径，只增不改不删），移除旧的后台品牌字体模板模块。
3. **跨源预览沙箱与多层网络隔离**：
   - 浏览器预览运行在独立的预览子域名（`final_cut.preview_origin`）下，凭 1 小时有效的无状态签名令牌按需读取工程文件；
   - HTTPS 下登录会话 Cookie 升级为 `__Host-iclip_session`（禁止子域名共享或覆盖），后端在路由前统一拦截非法 `Origin` 的写请求与 WebSocket 握手；
   - 渲染服务仅接受 `application/json` 请求以触发浏览器跨源预检拦截，并通过本地拒绝代理禁止无头 Chrome 访问回环以外的任何网络地址，缺失未声明字体时直接以 `font-missing` 报错终止。
4. **多语言变量值表与按语言配音导出**：原片语言统称「原文」（对应主文件根变量默认值），附加语言存为 `final-cut/locales/<locale>.json` 变量值表；口播字幕识别改为按需触发，预览与导出共用 `composition/` 的多语言文字合并与人声切换逻辑，单次导出产出指定语言版本的成片。

## 取舍

- **接受**：
  - 部署环境必须额外配置预览子域名解析与证书（本地联调需区分 `localhost` 与 `127.0.0.1`）；
  - 已拷入工程的元素与模板文件与公共组件库解耦，后续组件库升级不会自动更新旧工程内的副本；
  - 导出读取渲染启动时刻的工作区实时文件，不单独保存导出时刻的工程快照。
- **不做**：
  - 后端不对 `final-cut/` 内的 HTML/JS 内容做白名单清洗，安全边界完全由预览子域名隔离与渲染器离线沙箱保证；
  - `final-cut` 编辑器不做移动端窄屏折行适配。
