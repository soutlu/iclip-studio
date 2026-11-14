import { bootPreviewPage } from './preview-page'

// 预览页（whole-film-preview.html）的入口：令牌在地址的 # 后面
const start = async () =>
  bootPreviewPage(decodeURIComponent(window.location.hash.slice(1)), document.body)

start().catch((error: unknown) => {
  console.warn('预览页无法确认应用来源，已停止', error)
})
