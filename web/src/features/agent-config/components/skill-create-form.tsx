import { useId, useRef, useState, type FormEvent } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/field'
import { useCreateSkill } from '../skills.api'
import { PanelShell } from './panel-shell'

// 标识按 Agent Skills 规范（合同 §17、CONTEXT「技能库」），上限与后端一致。
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME = 64
const MAX_DISPLAY_NAME = 100
const MAX_DESCRIPTION = 1024

type Field = 'displayName' | 'name' | 'description'
type Errors = Partial<Record<Field | 'form', string>>

const LABEL_CLASS = 'text-label font-medium text-on-surface'

const validate = (values: Record<Field, string>): Errors => {
  const errors: Errors = {}
  if (values.displayName === '') errors.displayName = '请填写名称'
  if (values.name === '') errors.name = '请填写标识'
  else if (values.name.length > MAX_NAME || !NAME_PATTERN.test(values.name))
    errors.name = `标识只能用小写字母、数字和连字符，不以连字符开头或结尾、不连用，最多 ${MAX_NAME} 个字符`
  if (values.description === '') errors.description = '请填写简短说明'
  return errors
}

/** 新建技能：填名称、标识与简短说明，创建出只有草稿的技能，交回它的 id。 */
export function SkillCreateForm({
  onBack,
  onCreated,
}: {
  onBack: () => void
  onCreated: (skillId: string) => void
}) {
  const create = useCreateSkill()
  const baseId = useId()
  const [values, setValues] = useState<Record<Field, string>>({
    description: '',
    displayName: '',
    name: '',
  })
  const [errors, setErrors] = useState<Errors>({})
  const displayNameRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  const change = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    // 改哪一项就收起哪一项的错误，表单级的失败一并收起。
    setErrors(({ [field]: _dropped, form: _form, ...rest }) => rest)
  }

  const reject = (next: Errors) => {
    setErrors(next)
    const target =
      next.displayName !== undefined
        ? displayNameRef
        : next.name !== undefined
          ? nameRef
          : next.description !== undefined
            ? descriptionRef
            : null
    // 提交中字段是禁用的，等这一帧解除禁用后再聚焦。
    requestAnimationFrame(() => target?.current?.focus())
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = {
      description: values.description.trim(),
      displayName: values.displayName.trim(),
      name: values.name.trim(),
    }
    const problems = validate(trimmed)
    if (Object.keys(problems).length > 0) return reject(problems)
    try {
      const created = await create.mutateAsync(trimmed)
      onCreated(created.id)
    } catch (error) {
      // 标识已被占用是 409，原因写在标识下面；别的（含 422）写在表单底部。
      const message = errorMessageOf(error, '创建失败，请重试创建')
      reject(
        error instanceof ApiError && error.status === 409 ? { name: message } : { form: message },
      )
    }
  }

  const errorProps = (field: Field) =>
    errors[field] === undefined
      ? {}
      : { 'aria-describedby': `${baseId}-${field}-error`, 'aria-invalid': true }
  const fieldError = (field: Field) =>
    errors[field] === undefined ? null : (
      <span className="text-label text-error" id={`${baseId}-${field}-error`}>
        {errors[field]}
      </span>
    )
  const disabled = create.isPending

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <PanelShell
        footer={
          <>
            <Button disabled={disabled} onClick={onBack} size="md" variant="ghost">
              返回
            </Button>
            <Button loading={disabled} size="md" type="submit">
              创建技能
            </Button>
          </>
        }
        onClose={onBack}
        title="新建技能"
      >
        <div className="flex max-w-140 flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS} htmlFor={`${baseId}-displayName`}>
              名称
            </label>
            <Input
              autoComplete="off"
              disabled={disabled}
              id={`${baseId}-displayName`}
              maxLength={MAX_DISPLAY_NAME}
              onChange={(event) => change('displayName', event.currentTarget.value)}
              placeholder="例如：新品视频策划"
              ref={displayNameRef}
              value={values.displayName}
              {...errorProps('displayName')}
            />
            {fieldError('displayName')}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS} htmlFor={`${baseId}-name`}>
              标识
            </label>
            <Input
              autoCapitalize="none"
              autoComplete="off"
              className="tabular-nums"
              disabled={disabled}
              id={`${baseId}-name`}
              maxLength={MAX_NAME}
              onChange={(event) => change('name', event.currentTarget.value)}
              placeholder="product-video-planning"
              ref={nameRef}
              spellCheck={false}
              value={values.name}
              {...errorProps('name')}
            />
            {fieldError('name')}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS} htmlFor={`${baseId}-description`}>
              简短说明
            </label>
            <Textarea
              disabled={disabled}
              id={`${baseId}-description`}
              maxLength={MAX_DESCRIPTION}
              onChange={(event) => change('description', event.currentTarget.value)}
              placeholder="这个技能可以完成什么"
              ref={descriptionRef}
              rows={3}
              value={values.description}
              {...errorProps('description')}
            />
            {fieldError('description')}
          </div>
          {errors.form === undefined ? null : (
            <p className="text-body-sm text-error" role="alert">
              {errors.form}
            </p>
          )}
        </div>
      </PanelShell>
    </form>
  )
}
