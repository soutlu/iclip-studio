import { selectedRange, trimBounds, type Draft, type DraftItem, type Selection } from './draft'

export const secondsText = (value: number) => value.toFixed(1)

export const lengthDifference = (
  versionLabel: string,
  versionDuration: number,
  draftDuration: number,
): string | undefined => {
  const shorter = versionDuration - draftDuration
  if (Math.abs(shorter) < 0.05) return undefined
  return `比 ${versionLabel} ${shorter > 0 ? '短' : '长'} ${secondsText(Math.abs(shorter))} 秒`
}

const canTrim = (item: DraftItem | undefined, edge: 'start' | 'end') => {
  if (item?.kind !== 'clip') return false
  const { min, max } = trimBounds(item, edge)
  return min < max
}

// 抓手在选区两端：开头看第一段，结尾看最后一段。
const isTrimmable = (draft: Draft, selection: Selection) => {
  const range = selectedRange(draft, selection)
  return (
    range !== undefined && (canTrim(draft[range.from], 'start') || canTrim(draft[range.to], 'end'))
  )
}

type FootnoteInput = {
  notice: string | null
  loaded: boolean
  view: 'whole' | 'clips' | 'version'
  viewedLabel: string
  submitting: boolean
  waitingComposite: boolean
  draft: Draft
  selection: Selection
  positions: string | undefined
  blockReason: string | undefined
  generating: boolean
  changed: boolean
  difference: string | undefined
}

export const editorFootnote = ({
  notice,
  loaded,
  view,
  viewedLabel,
  submitting,
  waitingComposite,
  draft,
  selection,
  positions,
  blockReason,
  generating,
  changed,
  difference,
}: FootnoteInput): string => {
  if (notice !== null) return notice
  if (!loaded) return ''
  if (view === 'version') return `正在查看 ${viewedLabel}；点击「整条」可返回当前选用内容`
  if (submitting) return '正在提交，请等待提交完成后再离开'
  if (waitingComposite) return '正在合成，完成后将生成新版本；合成期间无法剪辑'
  if (view === 'whole') return '正在预览时间线当前选用内容；点击片段可查看和切换版本'
  if (positions !== undefined) {
    if (blockReason !== undefined) return `选中${positions}：${blockReason}`
    return isTrimmable(draft, selection)
      ? `选中${positions}：拖动两端可裁剪，按住中间拖动可调整顺序；如需 AI 重做，请在卡片中填写修改要求`
      : `选中${positions}：已是最短，无法继续裁剪；按住中间拖动可调整顺序，如需 AI 重做，请在卡片中填写修改要求`
  }
  if (generating) return 'AI 生成中，关闭窗口不影响生成；其他段可继续剪辑，生成完成后可合成'
  if (changed)
    return `${difference === undefined ? '' : `${difference}；`}已保存各片段选择，点击「合成新版本」按选用版本合成新的一版`
  return '点击片段选中，按住 Shift 可选择相邻片段；拖动两端可裁剪，按住中间可调序'
}
