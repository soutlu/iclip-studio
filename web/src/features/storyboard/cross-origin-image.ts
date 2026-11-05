import { UserFacingError } from '@/shared/api/client'

export const loadCrossOriginImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const element = new Image()
    element.crossOrigin = 'anonymous'
    element.onload = () => resolve(element)
    element.onerror = () =>
      reject(new UserFacingError('原图读取失败，请检查图片地址是否支持跨域访问'))
    element.src = url
  })
