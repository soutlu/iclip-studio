import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream/promises'
import { ExportFailure, type UploadTarget } from './jobs'

export async function uploadFile(
  file: string,
  target: UploadTarget,
  signal: AbortSignal,
): Promise<void> {
  const { size } = await stat(file)
  const url = new URL(target.url)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = { ...target.headers, 'Content-Length': String(size) }
  await new Promise<void>((resolve, reject) => {
    const req = send(url, { method: 'PUT', headers, signal }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        if (chunks.length < 16) chunks.push(chunk)
      })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status >= 200 && status < 300) resolve()
        else {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300)
          reject(new ExportFailure('upload-failed', `上传返回 ${status}${body ? `：${body}` : ''}`))
        }
      })
      res.on('error', (error) => reject(new ExportFailure('upload-failed', error.message)))
    })
    req.on('error', (error) => {
      if (signal.aborted) reject(error)
      else reject(new ExportFailure('upload-failed', error.message))
    })
    pipeline(createReadStream(file), req).catch((error: unknown) => {
      if (!signal.aborted) {
        reject(
          new ExportFailure(
            'upload-failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    })
  })
}
