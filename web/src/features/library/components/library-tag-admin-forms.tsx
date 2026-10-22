/** 标签管理的就地名称表单和规则编辑，共用现有输入、按钮与对话框组件。 */
import { useEffect, useId, useRef, useState } from 'react'
import type { LibraryTagUpdateIn } from '@/shared/api/generated/types.gen'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader } from '@/shared/ui/dialog'
import { Input, Textarea } from '@/shared/ui/field'
import { isAiDimension, type LibraryTag } from '../library-tags'

/** 新维度在分组区就地编辑，保存后由真实维度卡接替。 */
export function CreateDimensionForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const fieldId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  return (
    <form
      className="tag-admin__create-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && name.trim()) void onSubmit(name.trim())
      }}
    >
      <label className="sr-only" htmlFor={fieldId}>
        维度名称
      </label>
      <Input
        className="rounded-sm"
        disabled={busy}
        id={fieldId}
        maxLength={50}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder="输入维度名称"
        ref={inputRef}
        value={name}
      />
      <div className="tag-admin__create-actions">
        <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
          取消
        </Button>
        <Button
          disabled={!name.trim()}
          loading={busy}
          size="md"
          type="submit"
          variant={name.trim() ? 'inverted' : 'tonal'}
        >
          创建维度
        </Button>
      </div>
    </form>
  )
}

export function NameForm({
  label,
  placeholder,
  busy,
  onSubmit,
  onCancel,
  initialValue = '',
  focus = false,
  rename = false,
  continuous = false,
  error,
}: {
  label: string
  placeholder: string
  busy: boolean
  onSubmit: (name: string) => Promise<boolean>
  onCancel: () => void
  initialValue?: string
  focus?: boolean
  rename?: boolean
  continuous?: boolean
  error?: string | null
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  useEffect(() => {
    if (!focus) return
    inputRef.current?.focus()
    if (rename) inputRef.current?.select()
  }, [focus, rename])

  return (
    <form
      className="tag-admin__name-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || !value.trim()) return
        if (rename && value.trim() === initialValue) onCancel()
        else
          void onSubmit(value.trim()).then((saved) => {
            if (saved && continuous) {
              setValue('')
              inputRef.current?.focus({ preventScroll: true })
            }
          })
      }}
    >
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        aria-label={label}
        className="tag-admin__name-input"
        disabled={busy && !continuous}
        maxLength={50}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            if (event.key === 'Enter') event.preventDefault()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        placeholder={placeholder}
        readOnly={busy}
        ref={inputRef}
        value={value}
      />
      <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
        {continuous ? '结束' : '取消'}
      </Button>
      <Button
        disabled={!value.trim()}
        loading={busy}
        size="md"
        type="submit"
        variant={value.trim() ? 'inverted' : 'outlined'}
      >
        {rename ? '保存' : '添加'}
      </Button>
      {error ? (
        <p className="tag-admin__input-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function RulesEditor({
  tag,
  dimension,
  busy,
  onSave,
  onCancel,
  hint,
}: {
  tag: LibraryTag
  hint: string
  dimension: boolean
  busy: boolean
  onSave: (changes: LibraryTagUpdateIn) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(tag.name)
  const [guide, setGuide] = useState(tag.guide ?? '')
  const [autoFill, setAutoFill] = useState(() => isAiDimension(tag))
  const nameId = useId()
  const guideId = useId()

  return (
    <>
      <DialogHeader closeLabel="关闭设置" title={dimension ? '维度设置' : '标签设置'} />
      <DialogBody>
        <form
          className="tag-admin__rules"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || !name.trim()) return
            void onSave({
              ...(dimension ? { autoFill: autoFill ? 'ai' : null } : {}),
              guide: guide.trim() || null,
              name: name.trim(),
            })
          }}
        >
          <label className="tag-admin__field" htmlFor={nameId}>
            <span>{dimension ? '维度名称' : '标签名称'}</span>
            <Input
              disabled={busy}
              id={nameId}
              maxLength={50}
              onChange={(event) => setName(event.currentTarget.value)}
              value={name}
            />
          </label>
          {dimension ? (
            <div className="tag-admin__rule-mode">
              <div>
                <p>AI 自动打标</p>
                <span>开启后，AI 将根据判断说明选择这个维度的标签</span>
              </div>
              <button
                aria-checked={autoFill}
                aria-label="AI 自动打标"
                className="tag-admin__switch ui-focus"
                disabled={busy}
                onClick={() => setAutoFill(!autoFill)}
                role="switch"
                type="button"
              >
                <span />
              </button>
            </div>
          ) : null}
          <label className="tag-admin__field" htmlFor={guideId}>
            <span>判断说明</span>
            <Textarea
              disabled={busy}
              id={guideId}
              maxLength={1000}
              onChange={(event) => setGuide(event.currentTarget.value)}
              placeholder="说明如何判断，打标时会一并提供给 AI"
              rows={4}
              value={guide}
            />
          </label>
          <p className="tag-admin__hint">{hint}</p>
          <div className="tag-admin__dialog-actions">
            <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
              取消
            </Button>
            <Button
              disabled={!name.trim()}
              loading={busy}
              size="md"
              type="submit"
              variant="inverted"
            >
              保存
            </Button>
          </div>
        </form>
      </DialogBody>
    </>
  )
}
