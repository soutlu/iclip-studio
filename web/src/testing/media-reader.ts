/** jsdom 的媒体读取边界：按各套测试自己的文件表返回关键帧与时长，画面固定为 720×1280、无原声轨。 */
export const createMediaReaderMock = (
  files: ReadonlyMap<string, { keyframes: readonly number[]; duration: number }>,
) => {
  class UrlSource {
    readonly url: string
    constructor(url: string) {
      this.url = url
    }
  }
  class Input {
    private readonly url: string
    constructor(options: { source: UrlSource }) {
      this.url = options.source.url
    }
    getPrimaryVideoTrack = () =>
      Promise.resolve({
        url: this.url,
        canDecode: () => Promise.resolve(true),
        computeDuration: () => Promise.resolve(files.get(this.url)?.duration ?? 0),
        getDisplayWidth: () => Promise.resolve(720),
        getDisplayHeight: () => Promise.resolve(1280),
      })
    getPrimaryAudioTrack = () => Promise.resolve(null)
    computeDuration = () => Promise.resolve(files.get(this.url)?.duration ?? 0)
    dispose = () => {}
  }
  class EncodedPacketSink {
    private readonly keyframes: readonly number[]
    constructor(track: { url: string }) {
      this.keyframes = files.get(track.url)?.keyframes ?? []
    }
    getFirstKeyPacket = () => Promise.resolve(this.at(0))
    getNextKeyPacket = (packet: { timestamp: number }) =>
      Promise.resolve(this.at(this.keyframes.indexOf(packet.timestamp) + 1))
    private at = (index: number) => {
      const timestamp = this.keyframes[index]
      return timestamp === undefined ? null : { timestamp }
    }
  }
  return { EncodedPacketSink, Input, MP4: {}, QTFF: {}, UrlSource }
}
