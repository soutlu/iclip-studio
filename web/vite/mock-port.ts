import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const MAIN_WORKTREE_PORT = 3014
const WORKTREE_PORT_BASE = 3100
const WORKTREE_PORT_SPAN = 800

export const resolveMockPort = (): number => {
  const fromEnv = process.env['PORT']
  if (fromEnv !== undefined) {
    const port = Number(fromEnv)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`PORT 必须是 1–65535 的整数，收到：${fromEnv}`)
    }
    return port
  }

  const cwd = import.meta.dirname
  let output: string
  try {
    output = execFileSync(
      'git',
      ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (error) {
    throw new Error(`无法通过 git 定位当前 worktree，请用环境变量 PORT 指定 mock 端口（${cwd}）`, {
      cause: error,
    })
  }

  const [gitDir, commonDir, topLevel, ...rest] = output
    .trim()
    .split('\n')
    .map((line) => path.resolve(cwd, line))
  if (topLevel === undefined || rest.length > 0) {
    throw new Error(`git rev-parse 输出无法识别：${output}`)
  }
  if (gitDir === commonDir) {
    return MAIN_WORKTREE_PORT
  }

  const digest = createHash('sha1').update(topLevel).digest('hex')
  return WORKTREE_PORT_BASE + (Number.parseInt(digest.slice(0, 8), 16) % WORKTREE_PORT_SPAN)
}

// 输出字符串而非数字，避免 FORCE_COLOR 下 console.log 为数字附加 ANSI 颜色转义码。
if (import.meta.main) {
  console.log(String(resolveMockPort()))
}
