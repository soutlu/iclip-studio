import { fireEvent } from '@testing-library/react'

/** 往 ProseMirror 里整段放文字：走粘贴事件进它的事务管线。逐字键入用 `userEvent.keyboard`。 */
export const pasteTextIntoComposer = (editor: HTMLElement, text: string) => {
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
    },
  })
}

export const pasteFilesIntoComposer = (editor: HTMLElement, files: File[]) => {
  fireEvent.paste(editor, {
    clipboardData: {
      files,
      getData: () => '',
      items: files.map((file) => ({
        kind: 'file',
        type: file.type,
        webkitGetAsEntry: () => null,
      })),
      types: ['Files'],
    },
  })
}

export const dropFilesIntoWindow = (files: File[]) => {
  const dataTransfer = {
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      webkitGetAsEntry: () => null,
    })),
    types: ['Files'],
  }
  fireEvent.dragEnter(window, { dataTransfer })
  fireEvent.drop(window, { dataTransfer })
}

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
