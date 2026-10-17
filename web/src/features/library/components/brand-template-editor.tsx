import { useId, useRef, useState, type FormEvent } from 'react'
import {
  confirmBrandFont,
  updateBrandTemplate,
  uploadBrandFontFile,
  type BrandTemplate,
} from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { FONT_ACCEPT } from '@/shared/api/media-upload'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'

export type BrandTemplateEditing = { kind: 'create' } | { kind: 'edit'; template: BrandTemplate }

type Props = {
  editing: BrandTemplateEditing
  onClose: () => void
  onSaved: () => Promise<void>
}

export function BrandTemplateEditor({ editing, onClose, onSaved }: Props) {
  const formId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(editing.kind === 'edit' ? editing.template.name : '')
  const [brand, setBrand] = useState(editing.kind === 'edit' ? (editing.template.brand ?? '') : '')
  const [media, setMedia] = useState<{ file: File; uploadId: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (name.trim() === '') {
      setError('名称为空，无法保存；请填写名称')
      return
    }
    if (editing.kind === 'create' && media === null) {
      setError('尚未选择文件，无法保存；请选择字体文件')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const metadata = { name: name.trim(), brand: brand.trim() || null }
      if (editing.kind === 'edit') await updateBrandTemplate(editing.template.id, metadata)
      else if (media !== null) {
        const uploadId = media.uploadId ?? (await uploadBrandFontFile(media.file, setProgress))
        setMedia({ file: media.file, uploadId })
        await confirmBrandFont(uploadId, metadata)
      }
      toast.success(editing.kind === 'edit' ? '字体已更新' : '字体已上传')
      await onSaved()
    } catch (cause) {
      setError(errorMessageOf(cause, '保存字体失败，请重试'))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        returnFocus
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader
          closeLabel="关闭字体编辑"
          title={editing.kind === 'edit' ? '编辑字体' : '上传字体'}
        />
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogBody className="flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-name`}>
              名称
              <Input
                id={`${formId}-name`}
                disabled={busy}
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-brand`}>
              品牌
              <Input
                id={`${formId}-brand`}
                disabled={busy}
                maxLength={100}
                value={brand}
                placeholder="可选"
                onChange={(event) => setBrand(event.currentTarget.value)}
              />
            </label>
            {editing.kind === 'edit' ? null : (
              <div className="flex flex-col gap-2 text-body-sm">
                <label htmlFor={`${formId}-file`}>字体文件</label>
                <input
                  id={`${formId}-file`}
                  ref={fileRef}
                  className="sr-only"
                  accept={FONT_ACCEPT}
                  disabled={busy}
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    setMedia(file === undefined ? null : { file, uploadId: null })
                    if (file !== undefined && name.trim() === '')
                      setName(file.name.replace(/\.[^.]+$/, '').slice(0, 100))
                  }}
                />
                <div className="flex min-w-0 items-center gap-3">
                  <Button
                    type="button"
                    size="md"
                    variant="tonal"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    选择文件
                  </Button>
                  <span className="min-w-0 truncate text-on-surface-variant">
                    {media?.file.name ?? 'TTF / OTF'}
                  </span>
                </div>
              </div>
            )}
            {progress === null ? null : (
              <p role="status" className="text-body-sm text-on-surface-variant">
                {progress < 1 ? `正在上传 ${Math.round(progress * 100)}%` : '正在校验字体…'}
              </p>
            )}
            {error === null ? null : (
              <p role="alert" className="text-body-sm text-error">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
              取消
            </Button>
            <Button loading={busy} type="submit">
              {busy ? '正在保存…' : '保存字体'}
            </Button>
          </DialogFooter>
        </form>
      </DialogSurface>
    </DialogRoot>
  )
}
