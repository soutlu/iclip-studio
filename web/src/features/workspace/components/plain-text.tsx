/** 纯文本按正文字体原样换行，不加行号；没有专门渲染器的文件都走这里。 */
export function PlainText({ text }: { text: string }) {
  return (
    <p className="text-body leading-relaxed wrap-anywhere whitespace-pre-wrap text-on-surface">
      {text}
    </p>
  )
}
