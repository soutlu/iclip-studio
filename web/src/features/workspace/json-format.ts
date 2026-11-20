/** 把 JSON 原文排成两格缩进；解析不了时返回 `undefined`，由调用方照原文显示。 */
export const formatJson = (text: string): string | undefined => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return undefined
  }
}
