import { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import silentVideo from '@/testing/fixtures/sample-edited.mp4?inline'
import soundVideo from '@/testing/fixtures/sample-video.mp4?inline'
import { server } from '@/testing/mocks/server'
import { videoAudioQuery } from './material-media'

const bytesOf = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (char) => char.charCodeAt(0))

/** 按 Range 请求答复文件的一段，和存素材的服务一样。 */
const serve = (url: string, bytes: Uint8Array) =>
  server.use(
    http.get(url, ({ request }) => {
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') ?? '')
      if (range === null)
        return HttpResponse.arrayBuffer(bytes.slice().buffer, {
          headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' },
        })
      const start = Number(range[1])
      const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1)
      return HttpResponse.arrayBuffer(bytes.slice(start, end + 1).buffer, {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
        },
      })
    }),
  )

const SOUND_URL = 'https://media.test/videos/with-sound.mp4'
const SILENT_URL = 'https://media.test/videos/silent.mp4'
const MISSING_URL = 'https://media.test/videos/missing.mp4'

describe('videoAudioQuery', () => {
  it('读真的视频文件：带音轨的是 true，没有音轨的是 false，取不到文件时查询失败', async () => {
    serve(SOUND_URL, bytesOf(soundVideo))
    serve(SILENT_URL, bytesOf(silentVideo))
    server.use(http.get(MISSING_URL, () => new HttpResponse(null, { status: 404 })))
    const client = new QueryClient()

    expect(await client.fetchQuery(videoAudioQuery(SOUND_URL))).toBe(true)
    expect(await client.fetchQuery(videoAudioQuery(SILENT_URL))).toBe(false)
    await expect(client.fetchQuery(videoAudioQuery(MISSING_URL))).rejects.toThrow()
  })
})
