import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { Button, IconButton } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { useCreateAgent, useUpdateAgent, type AgentDetail } from '../agents.api'
import { PanelShell } from './panel-shell'
import { useEscapeWithin } from './use-escape-within'

// 标识的规矩见 CONTEXT「Agent 标识」；保留词由后端拦，报回来的原因写在标识下面。
const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

type Errors = { name?: string; id?: string; form?: string }

const LABEL_CLASS = 'text-label font-medium text-on-surface'

type Values = { name: string; id: string; description: string; listed: boolean }

type FieldRefs = {
  nameRef: RefObject<HTMLInputElement | null>
  idRef: RefObject<HTMLInputElement | null>
}

function DefinitionFields({
  disabled,
  errors,
  existingId,
  idRef,
  nameRef,
  onChange,
  values,
}: FieldRefs & {
  disabled: boolean
  errors: Errors
  /** 改已有的 agent 时标识只读。 */
  existingId: string | undefined
  onChange: (changes: Partial<Values>) => void
  values: Values
}) {
  const baseId = useId()
  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true })
  }, [nameRef])
  const errorProps = (field: 'name' | 'id') =>
    errors[field] === undefined
      ? {}
      : { 'aria-describedby': `${baseId}-${field}-error`, 'aria-invalid': true }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label className={LABEL_CLASS} htmlFor={`${baseId}-name`}>
          名称
        </label>
        <Input
          autoComplete="off"
          disabled={disabled}
          id={`${baseId}-name`}
          maxLength={100}
          onChange={(event) => onChange({ name: event.currentTarget.value })}
          placeholder="例如：创意助手"
          ref={nameRef}
          value={values.name}
          {...errorProps('name')}
        />
        <FieldError id={`${baseId}-name-error`}>{errors.name}</FieldError>
      </div>
      {existingId === undefined ? (
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor={`${baseId}-id`}>
            标识
          </label>
          <Input
            autoCapitalize="none"
            autoComplete="off"
            className="tabular-nums"
            disabled={disabled}
            id={`${baseId}-id`}
            maxLength={40}
            onChange={(event) => onChange({ id: event.currentTarget.value })}
            placeholder="creative-assistant"
            ref={idRef}
            spellCheck={false}
            value={values.id}
            {...errorProps('id')}
          />
          <FieldError id={`${baseId}-id-error`}>{errors.id}</FieldError>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>标识</span>
          <span className="inline-flex h-10 items-center gap-1.5 text-body-sm text-on-surface-variant tabular-nums">
            <Icon label="创建后不能修改" name="locked" size="xs" />
            {existingId}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label className={LABEL_CLASS} htmlFor={`${baseId}-description`}>
          说明
        </label>
        <Textarea
          disabled={disabled}
          id={`${baseId}-description`}
          onChange={(event) => onChange({ description: event.currentTarget.value })}
          placeholder="这个 Agent 用来做什么"
          rows={3}
          value={values.description}
        />
      </div>
      <div className="flex items-center justify-between border-t border-hairline pt-5">
        <span className="text-body text-on-surface" id={`${baseId}-listed`}>
          首页可见
        </span>
        <Switch
          aria-labelledby={`${baseId}-listed`}
          checked={values.listed}
          disabled={disabled}
          onCheckedChange={(listed) => onChange({ listed })}
        />
      </div>
      {errors.form === undefined ? null : (
        <p className="text-body-sm text-error" role="alert">
          {errors.form}
        </p>
      )}
    </div>
  )
}

function FieldError({ children, id }: { children: ReactNode; id: string }) {
  if (children === undefined) return null
  return (
    <span className="text-label text-error" id={id}>
      {children}
    </span>
  )
}

const useDefinitionForm = (initial: Values) => {
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<Errors>({})
  const nameRef = useRef<HTMLInputElement>(null)
  const idRef = useRef<HTMLInputElement>(null)
  const change = (changes: Partial<Values>) => {
    setValues((current) => ({ ...current, ...changes }))
    // 改哪一项就收起哪一项的错误，表单级的失败一并收起。
    setErrors((current) => ({
      ...(changes.name === undefined ? { name: current.name } : {}),
      ...(changes.id === undefined ? { id: current.id } : {}),
    }))
  }
  /** 标出错误，焦点落到第一个出错的字段上。 */
  const reject = (next: Errors) => {
    setErrors(next)
    const target = next.name !== undefined ? nameRef : next.id !== undefined ? idRef : null
    // 提交中字段是禁用的，等这一帧解除禁用后再聚焦。
    requestAnimationFrame(() => target?.current?.focus())
  }
  return { change, errors, refs: { idRef, nameRef }, reject, values }
}

/** 右侧的「Agent 定义」：改名称、说明与上不上首页；不进版本，保存即生效。 */
export function AgentDefinitionPanel({
  agent,
  onClose,
}: {
  agent: AgentDetail
  onClose: () => void
}) {
  const update = useUpdateAgent()
  const { change, errors, refs, reject, values } = useDefinitionForm({
    description: agent.description,
    id: agent.id,
    listed: agent.listed,
    name: agent.name,
  })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const name = values.name.trim()
    if (name === '') return reject({ name: '请填写名称' })
    try {
      await update.mutateAsync({
        changes: { description: values.description.trim(), listed: values.listed, name },
        id: agent.id,
      })
      onClose()
    } catch (error) {
      reject({ form: errorMessageOf(error, '保存失败，请重试保存') })
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <PanelShell
        footer={
          <>
            <Button disabled={update.isPending} onClick={onClose} size="md" variant="ghost">
              返回
            </Button>
            <Button loading={update.isPending} size="md" type="submit">
              保存
            </Button>
          </>
        }
        onClose={onClose}
        title="Agent 定义"
      >
        <DefinitionFields
          disabled={update.isPending}
          errors={errors}
          existingId={agent.id}
          onChange={change}
          values={values}
          {...refs}
        />
      </PanelShell>
    </form>
  )
}

/** 全宽的新建页：只填定义，创建后进入它的空配置。 */
export function CreateAgentPage({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (id: string) => void
}) {
  const create = useCreateAgent()
  const titleId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  useEscapeWithin(formRef, () => {
    if (!create.isPending) onCancel()
  })
  const { change, errors, refs, reject, values } = useDefinitionForm({
    description: '',
    id: '',
    listed: true,
    name: '',
  })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const name = values.name.trim()
    const id = values.id.trim()
    const problems: Errors = {}
    if (name === '') problems.name = '请填写名称'
    if (id === '') problems.id = '请填写标识'
    else if (!ID_PATTERN.test(id))
      problems.id = '标识以小写字母开头，只能用小写字母、数字和连字符，最多 40 个字符'
    if (problems.name !== undefined || problems.id !== undefined) return reject(problems)
    try {
      const created = await create.mutateAsync({
        description: values.description.trim(),
        id,
        listed: values.listed,
        name,
      })
      onCreated(created.id)
    } catch (error) {
      // 标识不合规矩（含保留词）是 422、被占用是 409，原因写在标识下面。
      const aboutId = error instanceof ApiError && (error.status === 422 || error.status === 409)
      const message = errorMessageOf(error, '创建失败，请重试创建')
      reject(aboutId ? { id: message } : { form: message })
    }
  }
  return (
    <section aria-labelledby={titleId} className="col-span-full flex min-h-0 overflow-y-auto">
      <form
        className="m-auto flex w-full max-w-140 flex-col gap-6 px-6 py-12"
        noValidate
        onSubmit={(event) => void submit(event)}
        ref={formRef}
      >
        <div className="flex items-center gap-2">
          <IconButton
            disabled={create.isPending}
            label="返回 Agent 配置"
            name="back"
            onClick={onCancel}
            size="md"
          />
          <h1 className="text-title-lg font-semibold text-on-surface" id={titleId}>
            新建 Agent
          </h1>
        </div>
        <DefinitionFields
          disabled={create.isPending}
          errors={errors}
          existingId={undefined}
          onChange={change}
          values={values}
          {...refs}
        />
        <div className="flex justify-end gap-2">
          <Button disabled={create.isPending} onClick={onCancel} size="md" variant="ghost">
            取消
          </Button>
          <Button loading={create.isPending} size="md" type="submit">
            创建并配置
          </Button>
        </div>
      </form>
    </section>
  )
}
