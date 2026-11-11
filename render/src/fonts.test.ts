import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { declareLinkedFonts } from './fonts'

let registry: string

beforeEach(async () => {
  registry = await mkdtemp(join(tmpdir(), 'iclip-render-fonts-'))
  await mkdir(join(registry, 'vendor/fonts/families'), { recursive: true })
  await writeFile(
    join(registry, 'vendor/fonts/families/dm-sans.css'),
    "@font-face{font-family:'DM Sans';src:url(../../npm/dm-sans/a.woff2) format('woff2')}\n",
  )
  await writeFile(
    join(registry, 'vendor/fonts/families/inter.css'),
    "@font-face{font-family:'Inter';font-weight:600;src:url('../../npm/inter/latin-600.woff2')}\n" +
      "@font-face{font-family:'Inter';font-weight:700;src:url(../../npm/inter/latin-700.woff2)}\n" +
      "@font-face{font-family:'Inter';font-weight:600;src:url(data:font/woff2;base64,AAAA)}\n",
  )
})

afterEach(async () => {
  await rm(registry, { recursive: true, force: true })
})

const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`

describe('declareLinkedFonts', () => {
  it('每个字体 CSS 的 link 前内联它每个字体的第一条 @font-face，url() 改成相对合成页；link 保留', async () => {
    const links =
      '<link rel="stylesheet" href="vendor/fonts/families/dm-sans.css">\n' +
      '<link rel="stylesheet" href="vendor/fonts/families/inter.css">\n' +
      '<link rel="stylesheet" href="compositions/components/x.css">'
    const output = await declareLinkedFonts(page(links), registry)

    expect(output).toMatch(/<style>@font-face\{font-family:'Inter'/)
    expect(output).toContain('url(vendor/npm/dm-sans/a.woff2)')
    expect(output).toContain('url(vendor/npm/inter/latin-600.woff2)')
    expect(output).not.toContain('latin-700')
    expect(output).not.toContain('base64,AAAA')
    expect(output.match(/<link rel="stylesheet"/g)).toHaveLength(3)
    expect(output.indexOf("'DM Sans'")).toBeLessThan(
      output.indexOf('href="vendor/fonts/families/dm-sans.css"'),
    )
    expect(output.indexOf('href="vendor/fonts/families/dm-sans.css"')).toBeLessThan(
      output.indexOf("'Inter'"),
    )
    expect(output.indexOf("'Inter'")).toBeLessThan(
      output.indexOf('href="vendor/fonts/families/inter.css"'),
    )
  })

  it('组件库里缺了引用的字体 CSS 时报错', async () => {
    const html = page('<link rel="stylesheet" href="vendor/fonts/families/anton.css">')
    await expect(declareLinkedFonts(html, registry)).rejects.toThrow(
      'vendor/fonts/families/anton.css',
    )
  })
})
