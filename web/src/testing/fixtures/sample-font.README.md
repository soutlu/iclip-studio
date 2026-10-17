# 测试字体

`sample-font.otf` 是 Noto Sans CJK SC Regular 的子集，改了名，只用于测试与 mock 预览；线上品牌字体由用户上传。前端单测、浏览器用例与后端集成测试 `server/tests/integration_no_llm/generation/test_whole_film_provider.py` 都按相对路径读它，文件位置不要改。

## 来源与许可

- 原字体：<https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf>
- 原文件 SHA-256：`2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`
- 许可：SIL Open Font License 1.1，全文见 `sample-font.LICENSE.txt`。字体内嵌的版权（name ID 0）、唯一标识（ID 3）、版本（ID 5）与许可（ID 13、14）记录保留原样。

## 子集的现状

- 字族名改为 `Iclip Test Sans`，PostScript 名改为 `IclipTestSans-Regular`：英文记录改了 name ID 1、4、6，简体中文记录改了 ID 1、4。
- 保留的表：`BASE`、`CFF `、`GPOS`、`GSUB`、`OS/2`、`VORG`、`cmap`、`head`、`hhea`、`hmtx`、`maxp`、`name`、`post`、`vhea`、`vmtx`。
- 保留的 OpenType 特性：GSUB 有 `liga`、`locl`、`vert`、`vrt2`，GPOS 有 `halt`、`kern`、`palt`、`vhal`、`vpal`。
- 字符：可打印 ASCII（U+0020–U+007E）、14 个全角标点 `、。「」！（），：；？＼｛｝`，以及 966 个测试夹具里用到的汉字，共 1075 个码位。

字符清单以 `sample-font-info.json` 的 `unicodeRanges` 为准。在 `web/` 下打印全部字符：

```bash
node -e "const {unicodeRanges}=JSON.parse(require('node:fs').readFileSync('src/testing/fixtures/sample-font-info.json','utf8'));console.log(unicodeRanges.flatMap(({start,end})=>Array.from({length:end-start+1},(_,i)=>String.fromCodePoint(start+i))).join(''))"
```

## 重新生成

当初子集化用的命令与参数没有记录，汉字取自哪些夹具文件也没有记录，仓库现状无法复原这一步。需要重做时，从上面的原字体出发，按上节列出的表、特性、字符与改名结果生成，再用下面的命令更新 `sample-font-info.json`。

## sample-font-info.json

它是 mock 的品牌字体信息接口（`src/testing/mocks/brand-templates.ts`）返回的内容，由后端读字体的同一套代码产出。在 `server/` 下执行：

```bash
uv run python -c "from pathlib import Path; from iclip.platform.media.fonts import inspect_font; from iclip.domains.brand_templates.schemas import BrandFontInfoOut; print(BrandFontInfoOut.of(inspect_font(Path('../web/src/testing/fixtures/sample-font.otf'))).model_dump_json(by_alias=True, indent=2))" > ../web/src/testing/fixtures/sample-font-info.json
```

对现有的 `sample-font.otf` 执行，输出与仓库里的 `sample-font-info.json` 逐字节相同。
