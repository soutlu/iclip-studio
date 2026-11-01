import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import {
  THINKING_LEVELS,
  ThinkingEmoji,
  thinkingLabel,
  type ThinkingLevel,
} from '@/shared/ui/thinking-level'
import { formatContextSize } from '../agent-draft'
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

const LABEL_CLASS = 'text-label font-medium text-on-surface-variant'
const INPUT_CLASS = 'h-(--control-height-lg) rounded-sm bg-top-layer px-3'
const GRID_CLASS = 'grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2'

// 上限与运行时一致（合同 §18、运行时 model_providers/models.py）。
const PROVIDER_NAME = /^[a-z0-9-]{1,64}$/
const MAX_LABEL = 50
const MAX_CREDENTIAL_NAME = 50
const MAX_MODEL_NAME = 200
const MAX_FIELD_VALUE = 2000
// 打码后的机密值以它开头；原样传回会被当成新值（合同 §18），所以拦下。
const MASK = '••••'

type Errors = Partial<Record<string, string>>
type Values = Record<string, string>
type CredentialField = Declaration['credentialFields'][number]

/** 试连的结果；`ok` 才能保存。改了任一接入字段就回到 idle。 */
type Test =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; elapsedMs: number }
  | { kind: 'failed'; reason: string }

const IDLE: Test = { kind: 'idle' }

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

/** 面板里就地展开的一块表单：浅灰底、标题、字段、底部一行（左边试连结果，右边按钮）。回车即保存。 */
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
  // 展开就把焦点放进第一个能填的字段，浏览器顺带把表单滚进视野。
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLInputElement>('input:not([readonly]):not(:disabled)')
      ?.focus()
  }, [])
  return (
    <form
      aria-label={title}
      className="mt-3 flex flex-col gap-4 rounded-md bg-surface-container-low p-4"
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

/** 试连的结果：通了是绿点加耗时，没通是红点加原因，试连中转圈。 */
function TestStatus({ test }: { test: Test }) {
  return (
    <span
      aria-live="polite"
      className="mr-auto inline-flex min-w-0 items-center gap-1.5 text-label text-on-surface-variant tabular-nums"
      role="status"
    >
      {test.kind === 'testing' ? (
        <>
          <Icon className="animate-spin" decorative name="loading" size="sm" />
          正在试连
        </>
      ) : test.kind === 'ok' ? (
        <>
          <span
            aria-label="试连通过"
            className="size-1.5 shrink-0 rounded-full bg-primary"
            role="img"
          />
          {test.elapsedMs} ms
        </>
      ) : test.kind === 'failed' ? (
        <>
          <span
            aria-label="试连没通过"
            className="size-1.5 shrink-0 rounded-full bg-error"
            role="img"
          />
          <span className="min-w-0 text-error">{test.reason}</span>
        </>
      ) : null}
    </span>
  )
}

/** 表单里各字段的初值：新建取声明里的默认值，修改取已存的值；机密字段一律空着。 */
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

/**
 * 要提交的字段：新建是填了的全部；修改只放真变了的，机密字段留空就是不改（合同 §18「字段」）。
 */
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
    // 新建时没填的用声明里的默认值；修改时机密字段留空就是不改。
    const mayBeEmpty =
      !field.required || (editing ? field.type === 'secret' : field.default !== null)
    if (value === '' && !mayBeEmpty) errors[field.name] = `请填写${field.label}`
  }
  return errors
}

/** 声明里的接入字段：机密字段是密码框；新建时名称与机密字段并排，其余字段占满一行。 */
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

/**
 * 添加供应商：选接入方式，填显示名与引用名，只建供应商。密钥在建好后的供应商下面添加并试连（合同 §18），
 * 没有密钥的供应商是正常状态。
 */
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
      next['name'] = '引用名只能用小写字母、数字和连字符，最多 64 个字符'
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
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <span className={LABEL_CLASS}>接入方式</span>
        <Segmented
          disabled={busy}
          label="接入方式"
          onValueChange={setDeclarationName}
          options={declarations.map((item) => ({ label: item.label, value: item.name }))}
          value={declarationName}
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
        <Field error={errors['name']} id={`${baseId}-name`} label="引用名">
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

/**
 * 添加或修改一把密钥。新建、或改了接入字段时要先试连通过才能保存；只改名不试连。
 * 修改时机密字段留空就是保持原值，提交里只放真变了的字段。
 */
export function CredentialForm({
  credential,
  declaration,
  onDone,
  provider,
}: {
  provider: ModelProvider
  declaration: Declaration | undefined
  /** null 是添加。 */
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
  const needsTest = !editing || Object.keys(changed).length > 0
  const canSave = (nameChanged || needsTest) && (!needsTest || test.kind === 'ok') && !busy

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
          : { kind: 'failed', reason: result.reason ?? '试连没通过' },
      )
    } catch (error) {
      setTest(IDLE)
      setFormError(errorMessageOf(error, '试连失败，请重试'))
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
            ...(needsTest ? { fields: changed } : {}),
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
            试连
          </Button>
          <Button disabled={!canSave} loading={saving} size="md" type="submit">
            保存
          </Button>
        </>
      }
      error={formError}
      onSubmit={() => void save()}
      status={<TestStatus test={test} />}
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

const MODEL_TYPES: readonly ModelType[] = ['llm', 'embedding', 'rerank']
const MODEL_APIS = ['responses', 'chat'] as const
type ModelApi = (typeof MODEL_APIS)[number]

/** 上下文长度：正整数，或带 K、M 的长度（按 1024 进位），如 128K；空是不写。不合格为 undefined。 */
const parseContextSize = (text: string): number | null | undefined => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(trimmed)
  if (match === null) return undefined
  const unit = match[2]?.toLowerCase()
  const size = Math.round(Number(match[1]) * (unit === 'm' ? 1024 * 1024 : unit === 'k' ? 1024 : 1))
  return size > 0 ? size : undefined
}

/**
 * 添加或修改自己加的模型（声明里的模型只能启停，不进这里）。名字与类型是模型的身份，修改时不能改；
 * 只有 llm 有接口、上下文长度与思考档位。
 */
export function ModelForm({
  model,
  onDone,
  provider,
}: {
  provider: ModelProvider
  /** null 是添加。 */
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
  const [api, setApi] = useState<ModelApi>(model?.api ?? 'responses')
  const [context, setContext] = useState(initialContext)
  const [thinking, setThinking] = useState<ThinkingLevel[]>(model?.thinking ?? [])
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const pending = addModel.isPending || updateModel.isPending

  const save = async () => {
    const next: Errors = {}
    if (name.trim() === '') next['name'] = '请填写模型名'
    // 没动过的长度原样带回，免得按 1024 进位改掉原来的值。
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
            api: llm ? api : null,
            contextSize: llm ? contextSize : null,
            name: name.trim(),
            thinking: llm ? ordered : [],
            type,
          },
          providerId: provider.id,
        })
      else
        await updateModel.mutateAsync({
          changes: { api, contextSize, thinking: ordered },
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
            options={MODEL_TYPES.map((value) => ({ label: value, value }))}
            value={type}
          />
        </div>
      </div>
      {type === 'llm' ? (
        <>
          <div className={GRID_CLASS}>
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              <span className={LABEL_CLASS}>接口</span>
              <Segmented
                disabled={pending}
                label="模型接口"
                onValueChange={setApi}
                options={MODEL_APIS.map((value) => ({ label: value, value }))}
                value={api}
              />
            </div>
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={LABEL_CLASS} id={`${baseId}-thinking`}>
              思考档位
            </span>
            <div
              aria-labelledby={`${baseId}-thinking`}
              className="flex flex-wrap gap-1.5"
              role="group"
            >
              {THINKING_LEVELS.map((level) => {
                const on = thinking.includes(level)
                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      'inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-1.5 rounded-full px-3 text-body-sm text-on-surface-variant ring-1 ring-border ui-focus ring-inset',
                      on && 'bg-state-active font-medium text-on-surface ring-0',
                    )}
                    disabled={pending}
                    key={level}
                    onClick={() =>
                      setThinking((current) =>
                        on ? current.filter((item) => item !== level) : [...current, level],
                      )
                    }
                    type="button"
                  >
                    <ThinkingEmoji level={level} />
                    {thinkingLabel(level)}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </InlineForm>
  )
}
