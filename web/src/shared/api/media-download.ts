import { useRef, useState } from 'react'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { toast } from '@/shared/ui/toast'

const saveAs = async (url: string, fallbackName: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const blob = await response.blob()
  if (blob.size === 0) throw new Error('Empty download')
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try {
    anchor.href = objectUrl
    anchor.download = fileNameOfUrl(url) || fallbackName
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  }
}

export const useMediaDownload = () => {
  const activeRef = useRef(false)
  const [downloading, setDownloading] = useState(false)

  const download = async (url: string, fallbackName: string): Promise<boolean> => {
    if (activeRef.current) return false
    activeRef.current = true
    setDownloading(true)
    try {
      await saveAs(url, fallbackName)
      return true
    } catch {
      toast.error('视频下载失败，请重试')
      return false
    } finally {
      activeRef.current = false
      setDownloading(false)
    }
  }

  return { downloading, download }
}
