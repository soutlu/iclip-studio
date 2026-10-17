import { useId, useRef, useState, type FormEvent } from 'react'
import {
  confirmBrandFont,
  createBrandTemplate,
  updateBrandTemplate,
  uploadBrandFontFile,
  type BrandTemplate,
} from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input, Select } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'
import {
  BRAND_TEMPLATE_KINDS,
  brandTemplateKindOf,
  type BrandTemplateKind,
} from '../brand-templates'

export type BrandTemplateEditing = { kind: 'create' } | { kind: 'edit'; template: BrandTemplate }

type Props = {
  editing: BrandTemplateEditing
  onClose: () => void
  onSaved: () => Promise<void>
}

const uploadOf = async (
  file: File,
  kind: BrandTemplateKind,
  onProgress: (ratio: number) => void,
): Promise<string> =>
  kind.media === 'font'
    ? uploadBrandFontFile(file, onProgress)
    : (await uploadMediaFile(file, 'video', { onProgress })).uploadId

export function BrandTemplateEditor({ editing, onClose, onSaved }: Props) {
  const formId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(editing.kind === 'edit' ? editing.template.name : '')
  const [brand, setBrand] = useState(editing.kind === 'edit' ? (editing.template.brand ?? '') : '')
  const [kind, setKind] = useState<BrandTemplateKind>(BRAND_TEMPLATE_KINDS[0])
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
      setError('尚未选择文件，无法保存；请选择资源文件')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const metadata = { name: name.trim(), brand: brand.trim() || null }
      if (editing.kind === 'edit') await updateBrandTemplate(editing.template.id, metadata)
      else if (media !== null) {
        const uploadId = media.uploadId ?? (await uploadOf(media.file, kind, setProgress))
        setMedia({ file: media.file, uploadId })
        if (kind.media === 'font') await confirmBrandFont(uploadId, metadata)
        else await createBrandTemplate({ ...metadata, kind: kind.value, uploadId })
      }
      toast.success(editing.kind === 'edit' ? '品牌资源已更新' : '品牌资源已创建')
      await onSaved()
    } catch (cause) {
      setError(errorMessageOf(cause, '保存品牌资源失败，请重试'))
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
          closeLabel="关闭资源编辑"
          title={editing.kind === 'edit' ? '编辑品牌资源' : '上传品牌资源'}
        />
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogBody className="flex flex-col gap-4">
            {editing.kind === 'edit' ? null : (
              <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-kind`}>
                类型
                <Select
                  id={`${formId}-kind`}
                  disabled={busy}
                  value={kind.value}
                  onChange={(event) => {
                    const next = brandTemplateKindOf(event.currentTarget.value)
                    if (next === undefined) return
                    setKind(next)
                    setMedia(null)
                    setError(null)
                    if (fileRef.current !== null) fileRef.current.value = ''
                  }}
                >
                  {BRAND_TEMPLATE_KINDS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
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
                <label htmlFor={`${formId}-file`}>资源文件</label>
                <input
                  id={`${formId}-file`}
                  ref={fileRef}
                  className="sr-only"
                  accept={kind.accept}
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
                    {media?.file.name ?? kind.fileHint}
                  </span>
                </div>
              </div>
            )}
            {progress === null ? null : (
              <p role="status" className="text-body-sm text-on-surface-variant">
                {progress < 1 ? `正在上传 ${Math.round(progress * 100)}%` : '正在校验资源…'}
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
              {busy ? '正在保存…' : '保存资源'}
            </Button>
          </DialogFooter>
        </form>
      </DialogSurface>
    </DialogRoot>
  )
}
