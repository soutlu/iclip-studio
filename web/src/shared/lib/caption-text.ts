// ASS 把反斜杠与花括号当作覆盖标签，换成全角才会照字面显示。
export const escapeAssControls = (text: string): string =>
  text.replaceAll('\\', '＼').replaceAll('{', '｛').replaceAll('}', '｝')

export const normalizeCaptionText = (text: string): string =>
  escapeAssControls(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
