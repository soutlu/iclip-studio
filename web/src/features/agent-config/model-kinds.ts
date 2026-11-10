import type { ModelType } from './model-providers.api'

/** 三类模型在界面上的排列顺序。 */
export const MODEL_KINDS: readonly ModelType[] = ['llm', 'embedding', 'rerank']

/** 模型类别给用户看的名字；发给接口的仍是 `ModelType` 原值。 */
export const MODEL_KIND_LABEL: Record<ModelType, string> = {
  embedding: '向量',
  llm: '对话',
  rerank: '重排',
}
