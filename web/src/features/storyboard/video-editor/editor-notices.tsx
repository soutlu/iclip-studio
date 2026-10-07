import { InlineAlert } from '@/shared/ui/inline-alert'

type Props = {
  modelsError: string | undefined
  onReloadModels: () => void
  chainError: string | undefined
  onReloadChain: () => void
  operationError: string | null
  /** 有一段的原声读不出来；波形先不画。 */
  peaksError: string | undefined
}

/** 输入栏下方的错误，按事实逐条列出，互不覆盖。 */
export function EditorNotices({
  modelsError,
  onReloadModels,
  chainError,
  onReloadChain,
  operationError,
  peaksError,
}: Props) {
  return (
    <>
      {modelsError === undefined ? null : (
        <InlineAlert
          action={{ label: '重新加载模型', onClick: onReloadModels }}
          message={modelsError}
        />
      )}
      {chainError === undefined ? null : (
        <InlineAlert action={{ label: '重试', onClick: onReloadChain }} message={chainError} />
      )}
      {operationError === null ? null : <InlineAlert message={operationError} />}
      {peaksError === undefined ? null : <InlineAlert message={peaksError} />}
    </>
  )
}
