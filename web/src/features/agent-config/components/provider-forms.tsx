import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { THINKING_LEVELS, type ThinkingLevel } from '@/shared/ui/thinking-level'
import { formatContextSize } from '../agent-draft'
import { MODEL_KIND_LABEL, MODEL_KINDS } from '../model-kinds'
import {
  testCredential,
  useAddModel,
  useCreateCredential,
  useCreateProvider,
  useUpdateCredential,
  useUpdateModel,
  type Declaration,
  type ModelProvider,
  type ModelType,
  type ProviderCredential,
  type ProviderModel,
} from '../model-providers.api'
import { Segmented } from './segmented'
import { ThinkingLevelOptions } from './thinking-controls'
import { TestStatus, type Test } from './test-status'

const IDLE: Test = { kind: 'idle' }

const LABEL_CLASS = 'text-label font-medium text-on-surface-variant'
const INPUT_CLASS = 'h-(--control-height-lg) rounded-sm bg-top-layer px-3'
const GRID_CLASS = 'grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2'

const PROVIDER_NAME = /^[a-z0-9-]{1,64}$/
const MAX_LABEL = 50
const MAX_CREDENTIAL_NAME = 50
const MAX_MODEL_NAME = 200
const MAX_FIELD_VALUE = 2000
const MASK = '••••'

type Errors = Partial<Record<string, string>>
type Values = Record<string, string>
type CredentialField = Declaration['credentialFields'][number]

const errorProps = (id: string, error: string | undefined) =>
  error === undefined ? {} : { 'aria-describedby': `${id}-error`, 'aria-invalid': true as const }

function Field({
  children,
  className,
  error,
  id,
  label,
}: {
  id: string
  label: string
  error?: string | undefined
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label className={LABEL_CLASS} htmlFor={id}>
        {label}
      </label>
      {children}
      {error === undefined ? null : (
        <span className="text-label text-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  )
}

function InlineForm({
  actions,
  children,
  error,
  onSubmit,
  status,
  title,
}: {
  title: string
  onSubmit: () => void
  children: ReactNode
  error: string | null
  status?: ReactNode
  actions: ReactNode
}) {
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLInputElement>('input:not([readonly]):not(:disabled)')
      ?.focus()
  }, [])
  return (
    <form
      aria-label={title}
      className="mt-3 flex flex-col gap-4 rounded-card bg-surface-container-low p-4"
      noValidate
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <h4 className="text-body font-semibold text-on-surface">{title}</h4>
      {children}
      {error === null ? null : (
        <p className="text-body-sm text-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status}
        {actions}
      </div>
    </form>
  )
}

const refusalOf = (error: unknown): string | null => {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  const body: unknown = error.body
  if (typeof body !== 'object' || body === null || !('detail' in body)) return null
  return typeof body.detail === 'string' && body.detail.trim() !== '' ? body.detail.trim() : null
}

const initialValues = (
  fields: readonly CredentialField[],
  saved: ProviderCredential | null,
): Values =>
  Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.type === 'secret'
        ? ''
        : saved === null
          ? (field.default ?? '')
          : (saved.fields[field.name] ?? ''),
    ]),
  )

const changedFields = (
  fields: readonly CredentialField[],
  values: Values,
  saved: ProviderCredential | null,
): Values => {
  const changed: Values = {}
  for (const field of fields) {
    const value = (values[field.name] ?? '').trim()
    if (saved === null || field.type === 'secret') {
      if (value !== '') changed[field.name] = value
    } else if (value !== (saved.fields[field.name] ?? '')) changed[field.name] = value
  }
  return changed
}

const fieldErrors = (
  fields: readonly CredentialField[],
  values: Values,
  editing: boolean,
): Errors => {
  const errors: Errors = {}
  for (const field of fields) {
    const value = (values[field.name] ?? '').trim()
    if (field.type === 'secret' && value.startsWith(MASK)) {
      errors[field.name] = `请输入新的${field.label}，不要粘贴打码后的值`
      continue
    }
    const mayBeEmpty =
      !field.required || (editing ? field.type === 'secret' : field.default !== null)
    if (value === '' && !mayBeEmpty) errors[field.name] = `请填写${field.label}`
  }
  return errors
}

function CredentialInputs({
  baseId,
  disabled,
  editing,
  errors,
  fields,
  onChange,
  values,
}: {
  baseId: string
  fields: readonly CredentialField[]
  values: Values
  errors: Errors
  editing: boolean
  disabled: boolean
  onChange: (name: string, value: string) => void
}) {
  return fields.map((field) => {
    const id = `${baseId}-field-${field.name}`
    const secret = field.type === 'secret'
    return (
      <Field
        className={secret ? undefined : '@min-[440px]:col-span-2'}
        error={errors[field.name]}
        id={id}
        key={field.name}
        label={field.label}
      >
        <Input
          autoComplete={secret ? 'new-password' : 'off'}
          className={cn(INPUT_CLASS, 'tabular-nums')}
          disabled={disabled}
          id={id}
          maxLength={MAX_FIELD_VALUE}
          onChange={(event) => onChange(field.name, event.currentTarget.value)}
          placeholder={
            secret ? (editing ? '留空保留原值' : undefined) : (field.default ?? undefined)
          }
          spellCheck={false}
          type={secret ? 'password' : 'text'}
          value={values[field.name] ?? ''}
          {...errorProps(id, errors[field.name])}
        />
      </Field>
    )
  })
}

export function ProviderCreateForm({
  declarations,
  onCancel,
  onCreated,
}: {
  declarations: readonly Declaration[]
  onCancel: () => void
  onCreated: (id: string) => void
}) {
  const baseId = useId()
  const createProvider = useCreateProvider()
  const [declarationName, setDeclarationName] = useState(declarations[0]?.name ?? '')
  const [label, setLabel] = useState('')
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const busy = createProvider.isPending

  const clearError = (key: string) => {
    setErrors(({ [key]: _dropped, ...rest }) => rest)
    setFormError(null)
  }

  const save = async () => {
    const next: Errors = {}
    if (label.trim() === '') next['label'] = '请填写显示名'
    if (!PROVIDER_NAME.test(name.trim()))
      next['name'] = '标识只能用小写字母、数字和连字符，最多 64 个字符'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0) return
    try {
      const provider = await createProvider.mutateAsync({
        label: label.trim(),
        name: name.trim(),
        provider: declarationName,
      })
      onCreated(provider.id)
    } catch (error) {
      setFormError(errorMessageOf(error, '添加供应商失败，请重试'))
    }
  }

  return (
    <InlineForm
      actions={
        <>
          <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
            取消
          </Button>
          <Button loading={busy} size="md" type="submit">
            添加
          </Button>
        </>
      }
      error={formError}
      onSubmit={() => void save()}
      title="添加供应商"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className={LABEL_CLASS}>接入方式</span>
        <Segmented
          disabled={busy}
          label="接入方式"
          onValueChange={setDeclarationName}
          options={declarations.map((item) => ({ label: item.label, value: item.name }))}
          value={declarationName}
          wrap
        />
      </div>
      <div className={GRID_CLASS}>
        <Field error={errors['label']} id={`${baseId}-label`} label="显示名">
          <Input
            autoComplete="off"
            className={INPUT_CLASS}
            disabled={busy}
            id={`${baseId}-label`}
            maxLength={MAX_LABEL}
            onChange={(event) => {
              setLabel(event.currentTarget.value)
              clearError('label')
            }}
            placeholder="例如：阿里云百炼"
            value={label}
            {...errorProps(`${baseId}-label`, errors['label'])}
          />
        </Field>
        <Field error={errors['name']} id={`${baseId}-name`} label="标识">
          <Input
            autoCapitalize="none"
            autoComplete="off"
            className={cn(INPUT_CLASS, 'tabular-nums')}
            disabled={busy}
            id={`${baseId}-name`}
            maxLength={64}
            onChange={(event) => {
              setName(event.currentTarget.value)
              clearError('name')
            }}
            placeholder="team-bailian"
            spellCheck={false}
            value={name}
            {...errorProps(`${baseId}-name`, errors['name'])}
          />
        </Field>
      </div>
    </InlineForm>
  )
}

export function CredentialForm({
  credential,
  declaration,
  onDone,
  provider,
}: {
  provider: ModelProvider
  declaration: Declaration | undefined
  credential: ProviderCredential | null
  onDone: () => void
}) {
  const baseId = useId()
  const createCredential = useCreateCredential()
  const updateCredential = useUpdateCredential()
  const fields = declaration?.credentialFields ?? []
  const editing = credential !== null
  const [name, setName] = useState(credential?.name ?? '')
  const [values, setValues] = useState<Values>(() => initialValues(fields, credential))
  const [errors, setErrors] = useState<Errors>({})
  const [test, setTest] = useState<Test>(IDLE)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = saving || test.kind === 'testing'

  const changed = changedFields(fields, values, credential)
  const nameChanged = name.trim() !== (credential?.name ?? '')
  const fieldsChanged = !editing || Object.keys(changed).length > 0
  const canSave = (nameChanged || fieldsChanged) && !busy

  const clearError = (key: string) => {
    setErrors(({ [key]: _dropped, ...rest }) => rest)
    setFormError(null)
  }

  const validate = (): boolean => {
    const next = fieldErrors(fields, values, editing)
    if (name.trim() === '') next['name'] = '请填写密钥名称'
    setErrors(next)
    setFormError(null)
    return Object.keys(next).length === 0
  }

  const runTest = async () => {
    if (!validate()) return
    setTest({ kind: 'testing' })
    try {
      const result = await testCredential(provider.id, {
        credentialId: credential?.id ?? null,
        fields: changed,
      })
      setTest(
        result.ok
          ? { elapsedMs: result.elapsedMs, kind: 'ok' }
          : { kind: 'failed', reason: result.reason ?? '测试连接没通过' },
      )
    } catch (error) {
      const refused = refusalOf(error)
      if (refused !== null) {
        setTest({ kind: 'failed', reason: refused })
        return
      }
      setTest(IDLE)
      setFormError(errorMessageOf(error, '测试连接失败，请重试'))
    }
  }

  const save = async () => {
    if (!canSave || !validate()) return
    setSaving(true)
    try {
      if (credential === null)
        await createCredential.mutateAsync({
          body: { fields: changed, name: name.trim() },
          providerId: provider.id,
        })
      else
        await updateCredential.mutateAsync({
          changes: {
            ...(nameChanged ? { name: name.trim() } : {}),
            ...(fieldsChanged ? { fields: changed } : {}),
          },
          id: credential.id,
          providerId: provider.id,
        })
      onDone()
    } catch (error) {
      setFormError(errorMessageOf(error, '密钥保存失败，请重试保存'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <InlineForm
      actions={
        <>
          <Button disabled={saving} onClick={onDone} size="md" variant="ghost">
            取消
          </Button>
          <Button
            disabled={saving}
            loading={test.kind === 'testing'}
            onClick={() => void runTest()}
            size="md"
            variant="outlined"
          >
            测试连接
          </Button>
          <Button disabled={!canSave} loading={saving} size="md" type="submit">
            保存
          </Button>
        </>
      }
      error={formError}
      onSubmit={() => void save()}
      status={<TestStatus action="测试连接" className="mr-auto" test={test} />}
      title={editing ? '编辑密钥' : '添加密钥'}
    >
      <div className={GRID_CLASS}>
        <Field error={errors['name']} id={`${baseId}-name`} label="名称">
          <Input
            autoComplete="off"
            className={INPUT_CLASS}
            disabled={busy}
            id={`${baseId}-name`}
            maxLength={MAX_CREDENTIAL_NAME}
            onChange={(event) => {
              setName(event.currentTarget.value)
              clearError('name')
            }}
            placeholder="例如：创作团队"
            value={name}
            {...errorProps(`${baseId}-name`, errors['name'])}
          />
        </Field>
        <CredentialInputs
          baseId={baseId}
          disabled={busy}
          editing={editing}
          errors={errors}
          fields={fields}
          onChange={(field, value) => {
            setValues((current) => ({ ...current, [field]: value }))
            clearError(field)
            setTest(IDLE)
          }}
          values={values}
        />
      </div>
    </InlineForm>
  )
}

type ModelApi = Declaration['apis'][number]

const parseContextSize = (text: string): number | null | undefined => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(trimmed)
  if (match === null) return undefined
  const unit = match[2]?.toLowerCase()
  const size = Math.round(Number(match[1]) * (unit === 'm' ? 1024 * 1024 : unit === 'k' ? 1024 : 1))
  return size > 0 ? size : undefined
}

export function ModelForm({
  declaration,
  model,
  onDone,
  provider,
}: {
  provider: ModelProvider
  declaration: Declaration
  model: ProviderModel | null
  onDone: () => void
}) {
  const baseId = useId()
  const addModel = useAddModel()
  const updateModel = useUpdateModel()
  const editing = model !== null
  const initialContext =
    model?.contextSize === null || model === null ? '' : formatContextSize(model.contextSize)
  const [name, setName] = useState(model?.name ?? '')
  const [type, setType] = useState<ModelType>(model?.type ?? 'llm')
  const apis = declaration.apis
  const [api, setApi] = useState<ModelApi | undefined>(model?.api ?? apis[0])
  const [context, setContext] = useState(initialContext)
  const [thinking, setThinking] = useState<ThinkingLevel[]>(model?.thinking ?? [])
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const pending = addModel.isPending || updateModel.isPending

  const save = async () => {
    const next: Errors = {}
    if (name.trim() === '') next['name'] = '请填写模型名'
    const contextSize =
      context === initialContext ? (model?.contextSize ?? null) : parseContextSize(context)
    if (contextSize === undefined)
      next['context'] = '上下文长度请写正整数，或带 K、M 的长度，如 128K'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0 || contextSize === undefined) return
    const llm = type === 'llm'
    const ordered = THINKING_LEVELS.filter((level) => thinking.includes(level))
    try {
      if (model === null)
        await addModel.mutateAsync({
          body: {
            api: llm ? (api ?? null) : null,
            contextSize: llm ? contextSize : null,
            name: name.trim(),
            thinking: llm ? ordered : [],
            type,
          },
          providerId: provider.id,
        })
      else
        await updateModel.mutateAsync({
          changes: { api: api ?? null, contextSize, thinking: ordered },
          model,
          providerId: provider.id,
        })
      onDone()
    } catch (error) {
      setFormError(errorMessageOf(error, '模型保存失败，请重试保存'))
    }
  }

  return (
    <InlineForm
      actions={
        <>
          <Button disabled={pending} onClick={onDone} size="md" variant="ghost">
            取消
          </Button>
          <Button loading={pending} size="md" type="submit">
            保存
          </Button>
        </>
      }
      error={formError}
      onSubmit={() => void save()}
      title={editing ? '编辑模型' : '添加模型'}
    >
      <div className={GRID_CLASS}>
        <Field error={errors['name']} id={`${baseId}-name`} label="模型名">
          <Input
            autoCapitalize="none"
            autoComplete="off"
            className={cn(INPUT_CLASS, 'tabular-nums read-only:text-on-surface-variant')}
            disabled={pending}
            id={`${baseId}-name`}
            maxLength={MAX_MODEL_NAME}
            onChange={(event) => {
              setName(event.currentTarget.value)
              setErrors(({ name: _name, ...rest }) => rest)
            }}
            placeholder="例如：qwen3.8-turbo"
            readOnly={editing}
            spellCheck={false}
            value={name}
            {...errorProps(`${baseId}-name`, errors['name'])}
          />
        </Field>
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <span className={LABEL_CLASS}>类型</span>
          <Segmented
            disabled={editing || pending}
            label="模型类型"
            onValueChange={setType}
            options={MODEL_KINDS.map((value) => ({ label: MODEL_KIND_LABEL[value], value }))}
            value={type}
          />
        </div>
      </div>
      {type === 'llm' ? (
        <>
          <div className={GRID_CLASS}>
            {apis.length > 1 && api !== undefined ? (
              <div className="flex min-w-0 flex-col items-start gap-1.5">
                <span className={LABEL_CLASS}>接口</span>
                <Segmented
                  disabled={pending}
                  label="模型接口"
                  onValueChange={setApi}
                  options={apis.map((value) => ({ label: value, value }))}
                  value={api}
                />
              </div>
            ) : null}
            <Field error={errors['context']} id={`${baseId}-context`} label="上下文长度">
              <Input
                autoComplete="off"
                className={cn(INPUT_CLASS, 'tabular-nums')}
                disabled={pending}
                id={`${baseId}-context`}
                onChange={(event) => {
                  setContext(event.currentTarget.value)
                  setErrors(({ context: _context, ...rest }) => rest)
                }}
                placeholder="128K"
                spellCheck={false}
                value={context}
                {...errorProps(`${baseId}-context`, errors['context'])}
              />
            </Field>
          </div>
          <ThinkingLevelOptions disabled={pending} onChange={setThinking} value={thinking} />
        </>
      ) : null}
    </InlineForm>
  )
}
