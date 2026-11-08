import type { ReactNode } from 'react'

export type ComposerNode = {
  readonly name: string
  readonly attrs: Readonly<Record<string, string | number>>
}

export type ComposerNodeSpec<N extends ComposerNode> = {
  readonly name: N['name']
  readonly attrNames: readonly (keyof N['attrs'] & string)[]
  leafText(node: N): string
  render(node: N): ReactNode
  readonly stopEvent?: (event: Event) => boolean
}

export type ErasedNodeSpec = {
  readonly name: string
  readonly attrNames: readonly string[]
  leafText(node: ComposerNode): string
  render(node: ComposerNode): ReactNode
  readonly stopEvent?: (event: Event) => boolean
}
