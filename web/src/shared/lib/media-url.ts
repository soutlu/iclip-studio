const OSS_PLAIN_URL = /^https?:\/\/[^/?#]*\.aliyuncs\.com\/[^?#]*$/

export const fileNameOfUrl = (url: string): string => {
  if (url.startsWith('data:')) return ''
  const path = url.split(/[?#]/, 1)[0] ?? url
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}

export const imageThumbnailUrl = (url: string, process = 'resize,l_64'): string =>
  OSS_PLAIN_URL.test(url) ? `${url}?x-oss-process=image/${process}` : url

export const videoSnapshotUrl = (url: string, width = 128, atSeconds = 0): string | undefined => {
  if (!OSS_PLAIN_URL.test(url)) return undefined
  const at = Math.max(0, Math.round(atSeconds * 1000))
  return `${url}?x-oss-process=video/snapshot,t_${at},f_jpg,w_${width},h_0${at === 0 ? ',m_fast' : ''}`
}
