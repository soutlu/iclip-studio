const HEX_32 = /^[0-9a-f]{32}$/

const dashed = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

export const mintUuid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // RFC 4122 UUID v4：第 7 字节高四位写入版本号 0100，第 9 字节高两位写入变体 10。
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return dashed(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

export const canonicalUuid = (raw: string): string | null => {
  const hex = raw.replaceAll('-', '').toLowerCase()
  return HEX_32.test(hex) ? dashed(hex) : null
}
