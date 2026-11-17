import { CARVE_SAMPLE_RATE, type CarveDecode } from './carve'

/**
 * 压低配乐分析用的解码（照参照的工作台）：取整个素材文件，用离线的音频上下文解成 `CARVE_SAMPLE_RATE` 的声音，
 * 取第一个声道。离线上下文不占播放设备，正在播放的预览不会卡一下。浏览器没有离线音频上下文、取不到、解不出时
 * 抛出错误（没有离线上下文时不去取文件）。
 */
export const decodeForCarve: CarveDecode = async (src) => {
  const context = new OfflineAudioContext(1, 1, CARVE_SAMPLE_RATE)
  const response = await fetch(src)
  if (!response.ok) throw new Error(`素材读取失败（${response.status}）`)
  const buffer = await context.decodeAudioData(await response.arrayBuffer())
  return buffer.getChannelData(0)
}
