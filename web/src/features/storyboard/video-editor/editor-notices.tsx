import { InlineAlert } from '@/shared/ui/inline-alert'

type Props = {
  chainError: string | undefined
  onReloadChain: () => void
  composeError: string | null
  /** 有一段的原声读不出来；波形先不画。 */
  peaksError: string | undefined
}

/** 时间线下方的错误，按事实逐条列出，互不覆盖。AI 改段的错误在弹出卡里。 */
export function EditorNotices({ chainError, onReloadChain, composeError, peaksError }: Props) {
  return (
    <>
      {chainError === undefined ? null : (
        <InlineAlert action={{ label: '重试', onClick: onReloadChain }} message={chainError} />
      )}
      {composeError === null ? null : <InlineAlert message={composeError} />}
      {peaksError === undefined ? null : <InlineAlert message={peaksError} />}
    </>
  )
}
