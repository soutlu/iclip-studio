/** 将 JSON 文本格式化为两空格缩进；解析失败时返回 `undefined`，由调用方按原文展示。 */
export const formatJson = (text: string): string | undefined => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return undefined
  }
}
