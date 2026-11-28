#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const BASELINE_PATH = join(ROOT, 'scripts', 'design-guard.baseline.json')

const EXEMPT = new Set(['src/app/base.css', 'src/app/globals.css'])

// 间距工具类前缀：变体（sm: / hover: / [&>*]: 等）以冒号结尾，前缀后可带旧式 ! 与负号。
const TW_SPACING =
  /(?:^|[\s'"`:])!?-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|scroll-[pm][xytrblse]?)-/
    .source
const CSS_SPACING_DECL =
  /(?<![\w-])(?:(?:row-|column-)?gap|(?:scroll-)?(?:padding|margin)(?:-[a-z-]+)?)\s*:([^;{}]*)/g
const CSS_PX = /(?<![\w.-])-?(\d*\.?\d+)px\b/g
const onCssSpacingGrid = (px) => px % 4 === 0 || (px <= 14 && px % 4 === 2)

const RULES = [
  {
    id: 'bare-hex-color',
    desc: '裸 hex 色值（应引用 --color-* token；含 4 / 8 位带透明度写法）',
    ext: ['.css', '.ts', '.tsx'],
    re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g,
  },
  {
    id: 'bare-rgb-color',
    desc: '裸 rgb()/rgba()/hsl()/oklch() 色值（应引用 token 或 color-mix(var(--…)))',
    ext: ['.css', '.ts', '.tsx'],
    re: /rgba?\(\s*\d|hsla?\(|oklch\(/g,
  },
  {
    id: 'primitive-palette-ref',
    desc: '直接引用原始色阶 --n* / --p* / --t* / --e*（应引用语义 token；没有对应语义角色的取值只放在模块开头的变量块里）',
    ext: ['.css', '.ts', '.tsx'],
    re: /var\(--[npte]\d+\)/g,
  },
  {
    id: 'tailwind-palette-class',
    desc: 'Tailwind 原色板类（本设计系统使用 4 族基础色阶与 5 槽低饱和分类色，不用 slate/blue/… 调色板）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])(?:bg|text|border|fill|stroke|ring|outline|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/g,
  },
  {
    id: 'tailwind-default-text-size',
    desc: 'Tailwind 默认字号档（字阶已清空重建，应使用 text-caption/label/body-sm/ui/body/title*/headline*/display*）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])text-(?:xs|sm|base|lg|xl|\dxl)\b/g,
  },
  {
    id: 'tailwind-default-shadow',
    desc: 'Tailwind 默认阴影档（应使用 shadow-1 / 2 / 3 / card / control-well、工作台的 shadow-panel / panel-card / pill / float / specular 或 shadow-[var(--shadow-xs)]）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])shadow-(?:xs|sm|md|lg|xl|2xl)\b/g,
  },
  {
    id: 'disallowed-font-weight-tsx',
    desc: '超规字重（界面只用 400 font-normal / 500 font-medium / 600 font-semibold，禁用 650 与 700+）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`:])font-(?:bold|extrabold|black|\[(?:650|[789]\d\d)\])\b/g,
  },
  {
    id: 'disallowed-font-weight-css',
    desc: 'CSS 超规字重（界面只用 400 / 500 / 600，禁用 bold / 650 / 700+）',
    ext: ['.css'],
    re: /font-weight:\s*(?:bold|bolder|650|[789]00)\b/g,
  },
  {
    id: 'tailwind-default-motion',
    desc: 'Tailwind 默认动效档（时长与曲线成对取 ui-motion-s / -m / -l）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])(?:duration-\d+|ease-(?:in-out|in|out|linear))\b/g,
  },
  {
    id: 'inline-style-color',
    desc: '内联 style 里的字面色（应经 token，或用 CSS 变量传值）',
    ext: ['.ts', '.tsx'],
    re: /(?:color|backgroundColor|borderColor|fill|stroke):\s*['"`]\s*(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g,
  },
  {
    id: 'svg-literal-fill',
    desc: 'SVG 字面填充色（图标一律 currentColor）',
    ext: ['.ts', '.tsx'],
    re: /(?:fill|stroke)="(?:#[0-9a-fA-F]{3,8}|rgba?\()/g,
  },
  {
    id: 'arbitrary-color-var',
    desc: '任意值引用颜色 token（已登记为工具类，直接写 bg-primary / text-on-surface）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])(?:bg|text|border|ring|outline|divide|fill|stroke|from|to|via|decoration|caret|accent)(?:-[trblxyse])?-\[(?:color:)?var\(--color-/g,
  },
  {
    id: 'arbitrary-shadow',
    desc: 'Tailwind 任意值阴影（应使用 shadow-[var(--shadow-*)]）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])shadow-\[(?!var\()/g,
  },
  {
    id: 'literal-box-shadow',
    desc: 'CSS box-shadow 含字面颜色（应引用 --shadow-* 或 token 色）',
    ext: ['.css'],
    re: /box-shadow:[^;]*(?:rgba?\(\s*\d|#[0-9a-fA-F]{3})/g,
  },
  {
    id: 'arbitrary-radius',
    desc: '任意值圆角（仅允许 rounded-[inherit] 与 calc(var(--radius-*)…) 几何补偿）',
    ext: ['.ts', '.tsx'],
    re: /rounded-\[(?!inherit\]|calc\(var\(--radius)/g,
  },
  {
    id: 'bare-border-radius',
    desc: 'CSS 裸 border-radius 像素值（应引用 var(--radius-*)）',
    ext: ['.css'],
    re: /border-radius:[^;]*[\d.]+px/g,
  },
  {
    id: 'arbitrary-text-size',
    desc: '任意值字号（应使用 text-caption/label/body-sm/ui/body/title*/headline*/display*）',
    ext: ['.ts', '.tsx'],
    re: /text-\[[\d.]+px\]/g,
  },
  {
    id: 'bare-font-size',
    desc: 'CSS 裸 font-size 像素值（应引用 var(--text-*)）',
    ext: ['.css'],
    re: /font-size:\s*[\d.]+px/g,
  },
  {
    id: 'bare-z-index-css',
    desc: 'CSS 裸 z-index 数值（应引用 var(--z-*)）',
    ext: ['.css'],
    re: /z-index:\s*\d/g,
  },
  {
    id: 'bare-z-index-tsx',
    desc: 'Tailwind 数字 z 类 / 任意值 z（应使用 layer-* 工具类；局部堆叠除外）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])z-(?:10|20|30|40|50|\[\d+\])/g,
  },
  {
    id: 'outline-none',
    desc: 'outline-none（键盘焦点指示缺失风险；有 ≥3:1 自定义 focus 样式方可豁免）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`])(?:focus:)?outline-none/g,
  },
  {
    id: 'primary-opacity-wash',
    desc: '主色透明叠层铺底（选中 / 展开 / 工具栏底用 state-active、state-focus、surface-container-*，成功状态底用 primary-container）',
    ext: ['.ts', '.tsx'],
    re: /(?:^|[\s'"`:])bg-primary(?:-container)?\/\d+/g,
  },
  {
    id: 'arbitrary-spacing',
    desc: '禁止手写 [Npx] 间距，请改用标准档位（如 px-5=20px / px-6=24px）或 --layout-* 变量',
    ext: ['.ts', '.tsx'],
    re: new RegExp(`${TW_SPACING}\\[-?[\\d.]+px\\]`, 'g'),
  },
  {
    id: 'off-grid-spacing-tsx',
    desc: '非法间距档位（仅允许整数档，及 ≤14px 的 0.5/1.5/2.5/3.5 小件半档）',
    ext: ['.ts', '.tsx'],
    // 半档只给 ≤14px 的紧凑小件：到 16px 以上人眼分不出 2px 差别，4.5 / 5.5 起一律拦；.25 / .75 不在栅格上
    re: new RegExp(`${TW_SPACING}(?:px|(?![0-3]\\.5(?![\\d.]))\\d+\\.\\d+)(?![\\w.])`, 'g'),
  },
  {
    id: 'off-grid-spacing-css',
    desc: 'CSS 间距须为 4px 倍数（≤14px 小件可用 2/6/10/14px），禁止 3px/5px/7px 等奇数零头',
    ext: ['.css'],
    // 一条声明可能含多个像素值，逐个计数
    count: (line) =>
      [...line.matchAll(CSS_SPACING_DECL)]
        .flatMap(([, value]) => [...value.matchAll(CSS_PX)])
        .filter(([, px]) => !onCssSpacingGrid(Number(px))).length,
  },
  {
    id: 'invalid-design-allow',
    desc: '豁免缺少原因说明（格式：design-allow -- <原因>）',
    ext: ['.css', '.ts', '.tsx'],
    re: /design-allow(?!\s*--\s*\S)/g,
  },
  {
    id: 'globals-feature-css-imports',
    desc: 'globals.css 引入业务样式（业务样式由所属功能的组件自己引入；全站入口里的存量只减不增）',
    // 只查这一个文件；它在 EXEMPT 里，别的规则不扫它
    only: ['src/app/globals.css'],
    ext: ['.css'],
    re: /^@import\s+['"]\.\.\/features\//g,
  },
]

const ALLOW_RE = /(?:\/\/|\/\*)\s*design-allow\s*--\s*\S/

// 单个样式文件的有效行上限：注释和空行不计。已经超过的存量文件逐个记在基线里，只减不增
const CSS_MAX_LINES = 500
const CSS_LINES_ID = 'css-file-max-lines'
const CSS_LINES_DESC = `单个样式文件不超过 ${CSS_MAX_LINES} 有效行（注释、空行不计）；超出的部分按分节拆到新文件`
const effectiveLines = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => line.trim() !== '').length

const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'testing') walk(p, acc)
    } else acc.push(p)
  }
  return acc
}

const files = walk(SRC).filter((p) => {
  const rel = relative(ROOT, p)
  return !EXEMPT.has(rel) && !/\.test\.[jt]sx?$/.test(p)
})

const counts = {}
const hits = {}
for (const rule of RULES) {
  counts[rule.id] = 0
  hits[rule.id] = []
  for (const file of rule.only?.map((rel) => join(ROOT, rel)) ?? files) {
    if (!rule.ext.some((e) => file.endsWith(e))) continue
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (rule.id !== 'invalid-design-allow' && i > 0 && ALLOW_RE.test(lines[i - 1])) return
      const n = rule.count ? rule.count(line) : (line.match(rule.re)?.length ?? 0)
      if (n) {
        counts[rule.id] += n
        hits[rule.id].push(`${relative(ROOT, file)}:${i + 1}`)
      }
    })
  }
}

const cssLines = new Map(
  files
    .filter((file) => file.endsWith('.css'))
    .map((file) => [relative(ROOT, file), effectiveLines(readFileSync(file, 'utf8'))]),
)

if (process.argv.includes('--update')) {
  const oversized = Object.fromEntries(
    [...cssLines]
      .filter(([, lines]) => lines > CSS_MAX_LINES)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ ...counts, [CSS_LINES_ID]: oversized }, null, 2)}\n`,
  )
  console.log('design-guard 基线已更新：')
  for (const rule of RULES) console.log(`  ${rule.id}: ${counts[rule.id]}`)
  for (const [file, lines] of Object.entries(oversized))
    console.log(`  ${CSS_LINES_ID}: ${file} ${lines} 行`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
} catch {
  console.error('缺少基线文件，先运行: node scripts/design-guard.mjs --update')
  process.exit(1)
}

let failed = false
let tightenable = false
for (const rule of RULES) {
  const base = baseline[rule.id] ?? 0
  const now = counts[rule.id]
  if (now > base) {
    failed = true
    console.error(`✗ ${rule.id}: ${now} 处（基线 ${base}）— ${rule.desc}`)
    console.error(`  新增命中参考：${hits[rule.id].slice(-8).join('  ')}`)
  } else if (now < base) {
    tightenable = true
    console.log(`↓ ${rule.id}: ${now} 处（基线 ${base}，可收紧）`)
  } else {
    console.log(`✓ ${rule.id}: ${now} 处`)
  }
}

// 基线里记了的文件以记下的行数为限，没记的以上限为限
const baseLines = baseline[CSS_LINES_ID] ?? {}
let linesClean = true
for (const [file, now] of cssLines) {
  const base = baseLines[file]
  if (now > (base ?? CSS_MAX_LINES)) {
    failed = true
    linesClean = false
    const limit = base === undefined ? `上限 ${CSS_MAX_LINES}` : `基线 ${base}`
    console.error(`✗ ${CSS_LINES_ID}: ${file} ${now} 行（${limit}）— ${CSS_LINES_DESC}`)
  } else if (base !== undefined && (now < base || now <= CSS_MAX_LINES)) {
    tightenable = true
    linesClean = false
    console.log(`↓ ${CSS_LINES_ID}: ${file} ${now} 行（基线 ${base}，可收紧）`)
  }
}
for (const file of Object.keys(baseLines)) {
  if (cssLines.has(file)) continue
  tightenable = true
  linesClean = false
  console.log(`↓ ${CSS_LINES_ID}: ${file} 已不存在（可收紧）`)
}
if (linesClean)
  console.log(
    `✓ ${CSS_LINES_ID}: 上限 ${CSS_MAX_LINES} 行，${Object.keys(baseLines).length} 个存量文件未超基线`,
  )

if (tightenable && !failed)
  console.log('存量减少：运行 node scripts/design-guard.mjs --update 收紧基线')
if (failed) {
  console.error(
    '\ndesign-guard 失败：按上面各条的说明处理（Token 规范见仓库根目录 design-system.html），勿新增硬编码。',
  )
  process.exit(1)
}
