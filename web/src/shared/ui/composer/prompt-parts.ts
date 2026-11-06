import { fileNameOfUrl } from '@/shared/lib/media-url'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { mediaDisplayName } from '@/shared/ui/media-preview'
import { type ComposerPart, readyAttachment } from './use-composer-attachments'

export const composerParts = (content: readonly PromptContentPart[]): ComposerPart[] =>
  content.map((part) =>
    part.type === 'text'
      ? { kind: 'text', text: part.text }
      : {
          kind: 'media',
          media: readyAttachment({
            kind: part.type,
            name: mediaDisplayName({ kind: part.type, name: fileNameOfUrl(part.source.url) }),
            url: part.source.url,
          }),
        },
  )
