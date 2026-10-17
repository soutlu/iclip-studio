/** 属性值转义：结果可放进单引号或双引号属性。 */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** JSON 放进属性值。 */
export function jsonAttribute(value: unknown): string {
  return escapeAttribute(JSON.stringify(value))
}

/** JSON 放进内联 `<script>`：转掉 `<` 与 JS 里的行分隔符，内容无法提前结束脚本。 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
}

/** 毫秒写成 HyperFrames 时间属性用的秒，精确到毫秒。 */
export function seconds(ms: number): string {
  return String(Math.round(ms) / 1000)
}
