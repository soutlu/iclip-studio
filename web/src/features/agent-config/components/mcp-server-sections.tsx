import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import {
  MAX_HEADERS,
  scopeNameProblem,
  timeoutOptions,
  type HeaderRow,
  type ScopeRow,
  type TestState,
  type Values,
} from '../mcp-server-form'
import type { McpTransport } from '../mcp-servers.api'
import { StatusDot } from './mcp-status'
import { CARD_SWITCH_HIT, CardGlyph, DIRECTORY_CARD } from './resource-card'
import { SectionHeading } from './section-heading'
import { Segmented } from './segmented'

const LABEL_CLASS = 'text-label font-medium text-on-surface-variant'
const INPUT_CLASS = 'h-(--control-height-lg) rounded-sm px-3'
const ROW_CLASS =
  'flex min-h-13 min-w-0 items-center gap-3 border-t border-hairline first:border-t-0'
const MASK_TAG =
  'inline-flex h-4.5 shrink-0 items-center rounded-xs bg-state-active px-1.5 text-caption text-on-surface-variant tabular-nums'

const TRANSPORTS = [
  { label: 'Streamable HTTP', value: 'streamable_http' },
  { label: 'SSE', value: 'sse' },
] as const satisfies readonly { label: string; value: McpTransport }[]

/** 字段的无障碍属性与错误文字。 */
export type FieldErrors = {
  has: (key: string) => boolean
  props: (key: string) => { 'aria-describedby'?: string; 'aria-invalid'?: true }
  error: (key: string) => ReactNode
}

function Field({
  children,
  className,
  htmlFor,
  label,
}: {
  label: string
  htmlFor: string
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label className={LABEL_CLASS} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

export function McpTestStatus({ className, test }: { test: TestState; className?: string }) {
  return (
    <span
      aria-live="polite"
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-label text-on-surface-variant tabular-nums',
        className,
      )}
      role="status"
    >
      {test.kind === 'testing' ? (
        <>
          <Icon className="animate-spin" decorative name="loading" size="sm" />
          正在测试连接
        </>
      ) : test.kind === 'ok' ? (
        <>
          <StatusDot status="connected" />
          {test.elapsedMs} ms
        </>
      ) : test.kind === 'failed' ? (
        <>
          <StatusDot status="failed" />
          <span className="line-clamp-2 min-w-0 text-error">{test.reason}</span>
        </>
      ) : null}
    </span>
  )
}

/** 已保存服务的头部：图标、名称（旁边是编辑按钮）、说明、地址，右侧是最近一次测试连接的结果。 */
export function IdentityHeader({
  onEdit,
  test,
  values,
}: {
  values: Values
  test: TestState
  onEdit: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <CardGlyph className="size-11" name="mcp-server" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-title font-semibold text-on-surface">
            {values.name.trim()}
          </span>
          <IconButton
            className="-my-1 shrink-0"
            label="编辑服务名称与地址"
            name="edit"
            onClick={onEdit}
            size="xs"
          />
        </span>
        {values.description.trim() === '' ? null : (
          <span className="truncate text-body-sm text-on-surface-variant">
            {values.description.trim()}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-label text-on-surface-faint tabular-nums">
          <Icon className="shrink-0" label="服务地址" name="link" size="xs" />
          <span className="truncate">{values.url.trim()}</span>
        </span>
      </div>
      <McpTestStatus className="max-w-1/2 shrink-0" test={test} />
    </div>
  )
}

/** 新建时，或点了头部的编辑按钮后，名称、标识、地址与说明的表单卡片；已保存的标识只读。 */
export function IdentityForm({
  baseId,
  creating,
  errors,
  onChange,
  values,
}: {
  baseId: string
  creating: boolean
  values: Values
  errors: FieldErrors
  onChange: (changes: Partial<Values>, connection: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-4 rounded-card bg-surface-container-low p-4">
      <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
        <Field htmlFor={`${baseId}-name`} label="服务名称">
          <Input
            autoComplete="off"
            className={INPUT_CLASS}
            id={`${baseId}-name`}
            maxLength={100}
            onChange={(event) => onChange({ name: event.currentTarget.value }, false)}
            value={values.name}
            {...errors.props('name')}
          />
          {errors.error('name')}
        </Field>
        <Field htmlFor={`${baseId}-id`} label="标识">
          <Input
            autoCapitalize="none"
            autoComplete="off"
            className={cn(INPUT_CLASS, 'tabular-nums', !creating && 'text-on-surface-variant')}
            id={`${baseId}-id`}
            maxLength={40}
            onChange={(event) => onChange({ id: event.currentTarget.value }, false)}
            placeholder={creating ? 'team-docs' : undefined}
            readOnly={!creating}
            spellCheck={false}
            title={creating ? undefined : '标识创建后不能修改'}
            value={values.id}
            {...errors.props('id')}
          />
          {errors.error('id')}
        </Field>
      </div>
      <Field htmlFor={`${baseId}-url`} label="服务地址">
        <Input
          autoComplete="off"
          className={cn(INPUT_CLASS, 'tabular-nums')}
          id={`${baseId}-url`}
          onChange={(event) => onChange({ url: event.currentTarget.value }, true)}
          placeholder="https://"
          spellCheck={false}
          type="url"
          value={values.url}
          {...errors.props('url')}
        />
        {errors.error('url')}
      </Field>
      <Field htmlFor={`${baseId}-description`} label="说明">
        <Input
          autoComplete="off"
          className={INPUT_CLASS}
          id={`${baseId}-description`}
          onChange={(event) => onChange({ description: event.currentTarget.value }, false)}
          value={values.description}
        />
      </Field>
    </div>
  )
}

function SettingRow({ children, label }: { label: string; children: ReactNode }) {
  return (
    <li className={cn(ROW_CLASS, 'flex-wrap justify-between gap-y-2 py-1.5')}>
      <span className="min-w-0 truncate text-body text-on-surface">{label}</span>
      {children}
    </li>
  )
}

export function ConnectionSection({
  onChange,
  values,
}: {
  values: Values
  onChange: (changes: Partial<Values>, connection: boolean) => void
}) {
  const titleId = useId()
  const timeouts = timeoutOptions(values.timeout)
  return (
    <section aria-labelledby={titleId} className="mt-7">
      <SectionHeading id={titleId} title="连接设置" />
      <ul className="flex flex-col">
        <SettingRow label="传输方式">
          <div className="w-69 max-w-full">
            <Segmented
              block
              label="传输方式"
              onValueChange={(transport) => onChange({ transport }, true)}
              options={TRANSPORTS}
              value={values.transport}
            />
          </div>
        </SettingRow>
        <SettingRow label="超时">
          <div className={cn('max-w-full', timeouts.length > 4 ? 'w-85' : 'w-69')}>
            <Segmented
              block
              label="超时"
              onValueChange={(seconds) => onChange({ timeout: Number(seconds) }, true)}
              options={timeouts.map((seconds) => ({
                label: `${seconds} 秒`,
                value: String(seconds),
              }))}
              value={String(values.timeout)}
            />
          </div>
        </SettingRow>
      </ul>
    </section>
  )
}

/** 请求头：每行名称与打码值；编辑或新加的行换成名称与值两个输入框（留空的值沿用原值）。 */
export function HeadersSection({
  errors,
  onAdd,
  onChangeRow,
  onRemove,
  rows,
}: {
  rows: readonly HeaderRow[]
  errors: FieldErrors
  onAdd: () => void
  onChangeRow: (key: string, changes: Partial<HeaderRow>) => void
  onRemove: (key: string) => void
}) {
  const titleId = useId()
  const full = rows.length >= MAX_HEADERS
  return (
    <section aria-labelledby={titleId} className="mt-7">
      <SectionHeading
        action={
          <IconButton
            disabled={full}
            label="添加请求头"
            name="add"
            onClick={onAdd}
            size="xs"
            tooltip={full ? `请求头最多 ${MAX_HEADERS} 个` : undefined}
          />
        }
        id={titleId}
        title="请求头"
      />
      <ul className="flex flex-col">
        {rows.map((row, index) => {
          const nameKey = `header-name-${row.key}`
          const valueKey = `header-value-${row.key}`
          const label = row.name.trim() === '' ? `第 ${index + 1} 个请求头` : row.name.trim()
          if (!row.editing && !errors.has(nameKey) && !errors.has(valueKey))
            return (
              <li className={cn(ROW_CLASS, 'group')} key={row.key}>
                <Icon
                  className="shrink-0 text-on-surface-faint"
                  decorative
                  name="credential"
                  size="sm"
                />
                <span className="min-w-0 flex-1 truncate text-body text-on-surface tabular-nums">
                  {row.name}
                </span>
                <span className="flex shrink-0 items-center opacity-0 transition-opacity ui-motion-s group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100">
                  <IconButton
                    label={`编辑请求头 ${label}`}
                    name="edit"
                    onClick={() => onChangeRow(row.key, { editing: true })}
                    size="xs"
                  />
                  <IconButton
                    label={`移除请求头 ${label}`}
                    name="close"
                    onClick={() => onRemove(row.key)}
                    size="xs"
                  />
                </span>
                {row.masked === null ? null : <span className={MASK_TAG}>{row.masked}</span>}
              </li>
            )
          return (
            <li
              className="flex min-w-0 flex-col gap-1 border-t border-hairline py-2 first:border-t-0"
              key={row.key}
            >
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
                <Input
                  aria-label={`请求头名称 ${index + 1}`}
                  autoComplete="off"
                  className={cn(INPUT_CLASS, 'tabular-nums')}
                  onChange={(event) => onChangeRow(row.key, { name: event.currentTarget.value })}
                  placeholder="Authorization"
                  spellCheck={false}
                  value={row.name}
                  {...errors.props(nameKey)}
                />
                <Input
                  aria-label={`请求头的值 ${index + 1}`}
                  autoComplete="off"
                  className={cn(INPUT_CLASS, 'tabular-nums')}
                  onChange={(event) => onChangeRow(row.key, { value: event.currentTarget.value })}
                  placeholder={row.masked ?? '值'}
                  title={row.masked === null ? undefined : '留空就沿用原值，填写新值会替换它'}
                  type="password"
                  value={row.value}
                  {...errors.props(valueKey)}
                />
                <IconButton
                  label={`移除请求头 ${index + 1}`}
                  name="close"
                  onClick={() => onRemove(row.key)}
                  size="sm"
                />
              </div>
              {errors.error(nameKey)}
              {errors.error(valueKey)}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function PerUserCard({
  checked,
  onCheckedChange,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const titleId = useId()
  return (
    <div className={cn(DIRECTORY_CARD, 'bg-background')}>
      <CardGlyph className="size-11" name="resource-people" />
      <span className="min-w-0 flex-1 truncate font-medium text-on-surface" id={titleId}>
        使用自有账户
      </span>
      <Switch
        aria-labelledby={titleId}
        checked={checked}
        className={CARD_SWITCH_HIT}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

/** 服务不能自动注册时管理员填的客户端：回调地址（可复制）、客户端 ID、客户端密钥（留空沿用已保存的）。 */
export function ClientCard({
  baseId,
  callbackUrl,
  maskedSecret,
  onChange,
  required,
  values,
}: {
  baseId: string
  required: boolean
  callbackUrl: string | null
  maskedSecret: string | null
  values: Values
  onChange: (changes: Partial<Values>) => void
}) {
  const { copied, copy } = useCopyFeedback()
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-card bg-surface-container-low p-4">
      <h4 className="text-body font-semibold text-on-surface">客户端</h4>
      {required ? (
        <p className="text-body-sm text-error" role="alert">
          该服务不支持自动注册，无法连接；请在服务方用下面的回调地址登记客户端，再填写客户端 ID
          与客户端密钥
        </p>
      ) : null}
      {callbackUrl === null ? null : (
        <Field htmlFor={`${baseId}-callback`} label="回调地址">
          <div className="flex min-w-0 items-center gap-2">
            <Input
              className={cn(INPUT_CLASS, 'text-on-surface-variant tabular-nums')}
              id={`${baseId}-callback`}
              readOnly
              value={callbackUrl}
            />
            <IconButton
              label="复制回调地址"
              name={copied ? 'check' : 'copy'}
              onClick={() => void copy(callbackUrl)}
              size="sm"
              tooltip={copied ? '已复制' : undefined}
            />
          </div>
        </Field>
      )}
      <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
        <Field htmlFor={`${baseId}-client-id`} label="客户端 ID">
          <Input
            autoComplete="off"
            className={cn(INPUT_CLASS, 'tabular-nums')}
            id={`${baseId}-client-id`}
            onChange={(event) => onChange({ clientId: event.currentTarget.value })}
            spellCheck={false}
            value={values.clientId}
          />
        </Field>
        <Field htmlFor={`${baseId}-client-secret`} label="客户端密钥">
          <Input
            autoComplete="off"
            className={cn(INPUT_CLASS, 'tabular-nums')}
            id={`${baseId}-client-secret`}
            onChange={(event) => onChange({ clientSecret: event.currentTarget.value })}
            placeholder={maskedSecret ?? undefined}
            title={maskedSecret === null ? undefined : '留空就沿用原值，填写新值会替换它'}
            type="password"
            value={values.clientSecret}
          />
        </Field>
      </div>
    </div>
  )
}

/** 权限：服务公布的每项一个开关（开 = 用户连接时申请）；「+」加一项服务没公布的。 */
export function ScopesSection({
  onChange,
  rows,
}: {
  rows: readonly ScopeRow[]
  onChange: (rows: ScopeRow[]) => void
}) {
  const titleId = useId()
  const inputId = useId()
  const [adding, setAdding] = useState<{ name: string; error: string | null } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const open = adding !== null
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  const commit = () => {
    if (adding === null) return
    const name = adding.name.trim()
    const problem = scopeNameProblem(name, rows)
    if (problem !== null) {
      setAdding({ ...adding, error: problem })
      return
    }
    onChange([...rows, { name, on: true }])
    setAdding(null)
  }
  return (
    <section aria-labelledby={titleId} className="mt-7">
      <SectionHeading
        action={
          <IconButton
            label="添加权限"
            name="add"
            onClick={() => setAdding({ error: null, name: '' })}
            size="xs"
          />
        }
        id={titleId}
        note="关闭的权限，用户连接时不再申请"
        title="权限"
      />
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li className={ROW_CLASS} key={row.name}>
            <span className="min-w-0 flex-1 truncate text-body text-on-surface tabular-nums">
              {row.name}
            </span>
            <Switch
              aria-label={row.name}
              checked={row.on}
              onCheckedChange={(on) =>
                onChange(rows.map((item) => (item.name === row.name ? { ...item, on } : item)))
              }
            />
          </li>
        ))}
        {adding === null ? null : (
          <li className="flex min-w-0 flex-col gap-1 border-t border-hairline py-2 first:border-t-0">
            <div className="flex min-w-0 items-center gap-2">
              <Input
                aria-describedby={adding.error === null ? undefined : `${inputId}-error`}
                aria-invalid={adding.error === null ? undefined : true}
                aria-label="新权限名称"
                autoComplete="off"
                className={cn(INPUT_CLASS, 'tabular-nums')}
                onChange={(event) => setAdding({ error: null, name: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commit()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setAdding(null)
                  }
                }}
                ref={inputRef}
                spellCheck={false}
                value={adding.name}
              />
              <Button onClick={commit} size="md" variant="ghost">
                添加
              </Button>
              <IconButton
                label="取消添加权限"
                name="close"
                onClick={() => setAdding(null)}
                size="sm"
              />
            </div>
            {adding.error === null ? null : (
              <span className="text-label text-error" id={`${inputId}-error`}>
                {adding.error}
              </span>
            )}
          </li>
        )}
      </ul>
    </section>
  )
}
