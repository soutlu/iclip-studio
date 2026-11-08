import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config'

const base = { RENDER_ALLOWED_MEDIA_HOSTS: 'oss.example.com', RENDER_REGISTRY_ROOT: 'registry' }

describe('loadConfig', () => {
  it('默认端口 8080、超时 30 分钟；组件库与临时目录都换成绝对路径', () => {
    const config = loadConfig(base)
    expect(config.port).toBe(8080)
    expect(config.timeoutMs).toBe(30 * 60 * 1000)
    expect(isAbsolute(config.registryRoot)).toBe(true)
    expect(isAbsolute(config.workDir)).toBe(true)
    expect(config.allowedHosts).toEqual(new Set(['oss.example.com']))
  })

  it.each([
    ['没有素材主机', { ...base, RENDER_ALLOWED_MEDIA_HOSTS: ' , ' }],
    ['没有组件库目录', { ...base, RENDER_REGISTRY_ROOT: '' }],
    ['端口不是正整数', { ...base, PORT: '80a' }],
    ['日志级别不认识', { ...base, LOG_LEVEL: 'verbose' }],
  ])('%s时报配置错误', (_, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError)
  })
})
