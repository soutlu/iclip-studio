#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { check, RUNTIME_PATHS, SPEC_PATH } from './check-design-system.mjs'
import { cn } from '../src/shared/lib/utils.ts'

const specHtml = readFileSync(SPEC_PATH, 'utf8')
const runtimeCss = RUNTIME_PATHS.map((p) => readFileSync(p, 'utf8')).join('\n')

test('真实规范与运行时逐名逐值一致', () => {
  const { spec, problems } = check({ specHtml, runtimeCss })
  assert.deepEqual(problems, [])
  assert.ok(spec.light.size > 0, '浅色契约不应为空')
  assert.ok(spec.dark.size > 0, '深色契约不应为空')
})

test('浅色色值被改动即报「值不同」', () => {
  const drifted = runtimeCss.replace('--color-tone-slate: #375971', '--color-tone-slate: #375970')
  assert.notEqual(drifted, runtimeCss, '注入漂移失败：目标声明没找到')
  const { problems } = check({ specHtml, runtimeCss: drifted })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /:root 值不同：--color-tone-slate/)
})

test('深色映射被改动即报 .dark 值不同', () => {
  const drifted = runtimeCss.replace('--color-surface: var(--n6)', '--color-surface: var(--n10)')
  assert.notEqual(drifted, runtimeCss, '注入漂移失败：目标声明没找到')
  const { problems } = check({ specHtml, runtimeCss: drifted })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /\.dark 值不同：--color-surface/)
})

test('颜色与材质阴影 token 没登记成工具类即报「工具类未登记」', () => {
  const drifted = runtimeCss
    .replace('  --color-tone-slate: var(--color-tone-slate);\n', '')
    .replace('  --shadow-card: var(--shadow-card);\n', '')
  assert.notEqual(drifted, runtimeCss, '注入漂移失败：目标登记行没找到')
  const { problems } = check({ specHtml, runtimeCss: drifted })
  assert.equal(problems.length, 2)
  assert.match(problems[0], /工具类未登记：--shadow-card/)
  assert.match(problems[1], /工具类未登记：--color-tone-slate/)
})

const merge = (classes) => cn(classes)

test('cn() 正确识别自定义字阶与海拔阴影类', () => {
  assert.equal(merge('text-body text-on-surface'), 'text-body text-on-surface')
  assert.equal(merge('text-ui text-on-surface'), 'text-ui text-on-surface')
  assert.equal(merge('text-body text-ui'), 'text-ui')
  assert.equal(merge('text-on-surface text-primary'), 'text-primary')
  assert.equal(merge('shadow-card shadow-none'), 'shadow-none')
  assert.equal(merge('shadow-control-well shadow-none'), 'shadow-none')
  assert.equal(merge('shadow-1 shadow-2'), 'shadow-2')
})
