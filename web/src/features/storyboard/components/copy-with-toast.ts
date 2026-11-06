import { errorMessageOf } from '@/shared/api/client'
import { copyText } from '@/shared/lib/clipboard'
import { toast } from '@/shared/ui/toast'

export const copyWithToast = async (text: string, message: string) => {
  try {
    await copyText(text)
    toast(message)
  } catch (error) {
    toast.error(errorMessageOf(error, '复制失败'))
  }
}
