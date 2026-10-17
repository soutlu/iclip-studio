import { useState } from 'react'
import type { BrandTemplate } from '@/shared/api/brand-templates'
import { normalizeCaptionText } from '@/shared/lib/caption-text'
import { usePreviewFont } from '@/shared/lib/use-preview-font'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { ListPending } from '@/shared/ui/list-state'

export function BrandFontPreviewDialog({
  font,
  onClose,
}: {
  font: BrandTemplate
  onClose: () => void
}) {
  const [text, setText] = useState('Made for your next adventure.')
  const preview = usePreviewFont(font, text)
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogSurface aria-describedby={undefined} returnFocus>
        <DialogHeader title={font.name} closeLabel="关闭字体预览" />
        <DialogBody className="flex flex-col gap-4">
          <Input
            aria-label="预览文字"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            maxLength={200}
          />
          <div className="grid min-h-40 place-items-center rounded-lg bg-surface-container-low p-6">
            {preview.kind === 'ready' ? (
              <p
                className="w-full text-center text-headline wrap-anywhere whitespace-pre-line"
                style={{
                  fontFamily: preview.fontFamily,
                  fontWeight: preview.fontWeight,
                  fontStyle: preview.fontStyle,
                }}
              >
                {normalizeCaptionText(text)}
              </p>
            ) : preview.kind === 'failed' || preview.kind === 'unsupported' ? (
              <div className="flex flex-col items-center gap-3">
                <p role="alert" className="text-body-sm text-error">
                  {preview.message}
                </p>
                {preview.kind === 'failed' ? (
                  <Button size="md" variant="tonal" onClick={preview.retry}>
                    重试
                  </Button>
                ) : null}
              </div>
            ) : (
              <ListPending label="正在加载字体…" />
            )}
          </div>
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
