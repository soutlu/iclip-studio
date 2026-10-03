/**
 * 对话里密排的 xs 图标按钮（24px）在触屏上的可点范围：伪元素四周各多出 8px，扩到 40×40，图标与桌面不变。
 * 按钮本身须是定位上下文（IconButton 已是 relative）。同排按钮之间要留 16px 间距、所在行至少 40px 高，
 * 相邻热区才正好挨着、不盖住旁边的按钮或上下的正文。
 */
export const TOUCH_HIT_40 = 'touch:after:absolute touch:after:-inset-2'
