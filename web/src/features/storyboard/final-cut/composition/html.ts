export function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function jsonAttribute(value: unknown): string {
  return escapeAttribute(JSON.stringify(value))
}

export function seconds(ms: number): string {
  return String(Math.round(ms) / 1000)
}
