/** 与字幕渲染端相同：规整换行与行首尾空白，把 ASS 控制字符换成可见的全角字形。 */
export const normalizeCaptionText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replaceAll('\\', '＼')
    .replaceAll('{', '｛')
    .replaceAll('}', '｝')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
