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
]

const ALLOW_RE = /(?:\/\/|\/\*)\s*design-allow\s*--\s*\S/

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
  for (const file of files) {
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

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`)
  console.log('design-guard 基线已更新：')
  for (const rule of RULES) console.log(`  ${rule.id}: ${counts[rule.id]}`)
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
if (tightenable && !failed)
  console.log('存量减少：运行 node scripts/design-guard.mjs --update 收紧基线')
if (failed) {
  console.error(
    '\ndesign-guard 失败：请改用 token（规范见仓库根目录 design-system.html），勿新增硬编码。',
  )
  process.exit(1)
}
