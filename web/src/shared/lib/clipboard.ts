export const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text)
    return
  }
  const holder = document.createElement('textarea')
  holder.value = text
  holder.setAttribute('readonly', '')
  holder.style.position = 'fixed'
  holder.style.opacity = '0'
  document.body.append(holder)
  holder.select()
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝了复制')
  } finally {
    holder.remove()
  }
}
