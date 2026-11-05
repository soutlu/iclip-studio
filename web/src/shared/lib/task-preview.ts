export type TaskPreview = {
  title: string
  requirement: string
  imageUrl: string | null
}

export type TaskPreviewState = 'loading' | 'error' | 'ready' | 'forbidden'
