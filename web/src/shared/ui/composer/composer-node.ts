/** 使用方自定义的行内原子节点：附件之外的 chip（图片编辑的标注、分镜正文的帧引用）。 */

import type { ReactNode } from 'react'

/** 节点只存身份：显示用的数据（编号、缩略图、选中态）在 render 里现取，portal 保留 React context。 */
export type ComposerNode = {
  readonly name: string
  readonly attrs: Readonly<Record<string, string | number>>
}

/** 节点的 schema 与渲染。spec 须是模块级常量：编辑器挂载时按它建 schema，之后不再读新的 spec。
 *
 * leafText、render 写成方法签名：参数按双变检查，具体节点的 spec 才能赋给编辑器内部的 ErasedNodeSpec；
 * 编辑器只会拿这个 spec 自己名下的节点调它们。 */
export type ComposerNodeSpec<N extends ComposerNode> = {
  readonly name: N['name']
  readonly attrNames: readonly (keyof N['attrs'] & string)[]
  /** 复制成纯文本时的字，如「标注 2」「@Image3」。 */
  leafText(node: N): string
  /** 节点内容，渲染进编辑器给的行内宿主。返回单个行内元素：选中节点时 composer 给它画选中环，
   * 它自己带 `data-selected` 时也画同一个环。 */
  render(node: N): ReactNode
}

/** 编辑器内部认的 spec：不带类型参数，结构比较，任何 `ComposerNodeSpec<N>` 都能赋给它。 */
export type ErasedNodeSpec = {
  readonly name: string
  readonly attrNames: readonly string[]
  leafText(node: ComposerNode): string
  render(node: ComposerNode): ReactNode
}
