export function PlainText({ text }: { text: string }) {
  return (
    <p className="text-body leading-relaxed wrap-anywhere whitespace-pre-wrap text-on-surface">
      {text}
    </p>
  )
}
