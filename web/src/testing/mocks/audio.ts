import { http, HttpResponse } from 'msw'

export const MOCK_MUSIC_SECONDS = 30
const MOCK_MUSIC_BPM = 120

export const MOCK_MUSIC_URL = 'http://localhost/mock-audio/generated.wav'

const SAMPLE_RATE = 22_050

const beatTrackWav = (seconds: number, bpm: number): ArrayBuffer => {
  const length = Math.round(seconds * SAMPLE_RATE)
  const samples = Float32Array.from({ length }, (_, index) => {
    const time = index / SAMPLE_RATE
    return 0.2 * Math.sin(2 * Math.PI * 660 * time) + 0.15 * Math.sin(2 * Math.PI * 880 * time)
  })
  const beatSamples = (60 / bpm) * SAMPLE_RATE
  const kickSamples = Math.round(0.15 * SAMPLE_RATE)
  for (let beat = 0; beat * beatSamples < length; beat += 1) {
    const from = Math.round(beat * beatSamples)
    const level = beat % 4 === 0 ? 0.6 : 0.5
    for (let index = 0; index < kickSamples && from + index < length; index += 1) {
      const time = index / SAMPLE_RATE
      samples[from + index] =
        (samples[from + index] ?? 0) +
        level * Math.exp(-time * 25) * Math.sin(2 * Math.PI * 60 * time)
    }
  }
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(at + index, value.charCodeAt(index))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, length * 2, true)
  samples.forEach((sample, index) => {
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32_767), true)
  })
  return buffer
}

let generated: ArrayBuffer | undefined

export const audioHandlers = [
  http.get('*/mock-audio/generated.wav', () => {
    generated ??= beatTrackWav(MOCK_MUSIC_SECONDS, MOCK_MUSIC_BPM)
    return new HttpResponse(generated.slice(0), { headers: { 'Content-Type': 'audio/wav' } })
  }),
]
