import { useId, useRef, useState, type ReactNode } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { McpHeaderIn } from '@/shared/api/generated/types.gen'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { Switch } from '@/shared/ui/switch'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import type { AgentConfig } from '../agents.api'
import {
  MCP_STATUS_LABEL,
  mcpBindingOf,
  selectAllMcpTools,
  selectedMcpTools,
  setMcpTool,
  unbindMcp,
} from '../mcp-draft'
import {
  useCheckMcpConfig,
  useDeleteMcpServer,
  useMcpServers,
  useSaveMcpServer,
  type McpCheck,
  type McpServer,
  type McpTransport,
} from '../mcp-servers.api'
import { StatusDot } from './mcp-status'
import type { Panel } from './panel'
import { PanelShell } from './panel-shell'
import { CardBadge } from './resource-card'
import { Segmented } from './segmented'

// 标识的规矩同 agent 标识（CONTEXT「MCP 服务」）；保留词与占用由后端拦，原因写在标识下面。
const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
// HTTP 头名字的 token 字符（合同 §22「字段」）。
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MAX_HEADERS = 20

const TRANSPORTS = [
  { label: 'Streamable HTTP', value: 'streamable_http' },
  { label: 'SSE', value: 'sse' },
] as const satisfies readonly { label: string; value: McpTransport }[]

const LABEL_CLASS = 'text-label font-medium text-on-surface-variant'
const INPUT_CLASS = 'h-(--control-height-lg) rounded-sm px-3'

type HeaderRow = {
  key: string
  name: string
  /** 已保存的请求头名字与打码值；新加的一行都是 null。 */
  savedName: string | null
  masked: string | null
  /** 新填的值；已保存的一行留空就是沿用原值。 */
  value: string
}

type Values = {
  id: string
  name: string
  description: string
  url: string
  transport: McpTransport
  timeout: string
  headers: HeaderRow[]
}

/** 测试连接的结果。`fresh` 是这次打开面板后按当前填的配置测过；只有它通过了才能保存。 */
type TestState =
  | { kind: 'none' }
  | { kind: 'testing' }
  | { kind: 'ok'; elapsedMs: number; fresh: boolean }
  | { kind: 'failed'; reason: string; fresh: boolean }

type Errors = Partial<Record<string, string>>

const valuesOf = (server: McpServer | undefined): Values => ({
  description: server?.description ?? '',
  headers: (server?.headers ?? []).map((header, index) => ({
    key: `saved-${index}`,
    masked: header.value,
    name: header.name,
    savedName: header.name,
    value: '',
  })),
  id: server?.id ?? '',
  name: server?.name ?? '',
  timeout: String(server?.timeoutSeconds ?? 30),
  transport: server?.transport ?? 'streamable_http',
  url: server?.url ?? '',
})

const testOf = (server: McpServer | undefined): TestState => {
  const check = server?.lastCheck ?? null
  if (check === null) return { kind: 'none' }
  return check.ok
    ? { elapsedMs: check.elapsedMs, fresh: false, kind: 'ok' }
    : { fresh: false, kind: 'failed', reason: check.reason ?? MCP_STATUS_LABEL.failed }
}

const testOfCheck = (check: McpCheck, fresh: boolean): TestState =>
  check.ok
    ? { elapsedMs: check.elapsedMs, fresh, kind: 'ok' }
    : { fresh, kind: 'failed', reason: check.reason ?? MCP_STATUS_LABEL.failed }

/** 已保存的一行没改名字、也没填新值：沿用原值，提交时不带 `value`（合同 §22「请求头只给打码值」）。 */
const keepsSavedValue = (row: HeaderRow) =>
  row.value === '' &&
  row.savedName !== null &&
  row.savedName.toLowerCase() === row.name.trim().toLowerCase()

const headersOf = (rows: readonly HeaderRow[]): McpHeaderIn[] =>
  rows.map((row) =>
    keepsSavedValue(row) ? { name: row.name.trim() } : { name: row.name.trim(), value: row.value },
  )

/** 合同只收带主机的 http:// 或 https:// 地址。 */
const isHttpUrl = (text: string): boolean => {
  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== ''
  } catch {
    return false
  }
}

const validate = (values: Values, creating: boolean): Errors => {
  const errors: Errors = {}
  if (values.name.trim() === '') errors['name'] = '请填写服务名称'
  if (creating) {
    const id = values.id.trim()
    if (id === '') errors['id'] = '请填写标识'
    else if (!ID_PATTERN.test(id))
      errors['id'] = '标识以小写字母开头，只能用小写字母、数字和连字符，最多 40 个字符'
  }
  if (!isHttpUrl(values.url.trim())) errors['url'] = '请填写以 http:// 或 https:// 开头的完整地址'
  const timeout = Number(values.timeout.trim())
  if (!/^\d+$/.test(values.timeout.trim()) || timeout < 1 || timeout > 300)
    errors['timeout'] = '请填写 1 到 300 之间的整数'
  const seen = new Set<string>()
  for (const row of values.headers) {
    const name = row.name.trim()
    if (name === '') errors[`header-name-${row.key}`] = '请填写请求头名称'
    else if (!HEADER_NAME_PATTERN.test(name))
      errors[`header-name-${row.key}`] =
        "请求头名称只能用英文字母、数字和 ! # $ % & ' * + - . ^ _ ` | ~"
    else if (seen.has(name.toLowerCase())) errors[`header-name-${row.key}`] = '请求头名称不能重复'
    seen.add(name.toLowerCase())
    if (row.value === '' && !keepsSavedValue(row))
      errors[`header-value-${row.key}`] = '请填写请求头的值'
  }
  return errors
}

type McpServerPanelProps = {
  /** null 是添加新服务。 */
  serverId: string | null
  back: 'mcp-library' | 'mcp-select' | null
  /** 刚建好时随后的试连请求出错的原因，开面板时写在状态行。 */
  checkError: string | undefined
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  onOpenPanel: (panel: Panel | null) => void
}

/**
 * 一个 MCP 服务的配置：名称与说明，「连接」改地址、连接方式、时限与请求头，测试通过后才能保存；
 * 「工具」选当前 agent 放出哪几个工具（没挂到当前 agent 时只能看）。保存改的是服务本身，选工具改的是草稿。
 */
export function McpServerPanel({
  back,
  checkError,
  config,
  onChange,
  onOpenPanel,
  serverId,
}: McpServerPanelProps) {
  const servers = useMcpServers()
  const close = () => onOpenPanel(back === null ? null : { type: back })
  if (serverId === null)
    return (
      <McpServerForm
        back={back}
        checkError={undefined}
        config={config}
        key="new"
        onChange={onChange}
        onClose={close}
        onOpenPanel={onOpenPanel}
        server={undefined}
      />
    )
  if (servers.isPending || servers.isError)
    return (
      <PanelShell footer={false} onClose={close} title="配置 MCP">
        {servers.isPending ? (
          <ListPending label="正在读取 MCP 服务…" />
        ) : (
          <ListError message={servers.error.message} onRetry={() => void servers.refetch()} />
        )}
      </PanelShell>
    )
  const server = servers.data.find((item) => item.id === serverId)
  if (server === undefined) {
    const bound = mcpBindingOf(config, serverId) !== undefined
    return (
      <PanelShell
        actions={
          bound ? (
            <IconButton
              label="从当前 Agent 移除"
              name="delete"
              onClick={() => {
                onChange(unbindMcp(config, serverId))
                close()
              }}
              size="md"
            />
          ) : undefined
        }
        footer={false}
        onClose={close}
        title="配置 MCP"
      >
        <p className="py-8 text-center text-on-surface-faint">
          MCP 服务「{serverId}」已不存在，请从当前 Agent 移除
        </p>
      </PanelShell>
    )
  }
  return (
    <McpServerForm
      back={back}
      checkError={checkError}
      config={config}
      key={server.id}
      onChange={onChange}
      onClose={close}
      onOpenPanel={onOpenPanel}
      server={server}
    />
  )
}

function McpServerForm({
  back,
  checkError,
  config,
  onChange,
  onClose,
  onOpenPanel,
  server,
}: {
  server: McpServer | undefined
  checkError: string | undefined
  back: 'mcp-library' | 'mcp-select' | null
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  onClose: () => void
  onOpenPanel: (panel: Panel | null) => void
}) {
  const creating = server === undefined
  const baseId = useId()
  const [values, setValues] = useState<Values>(() => valuesOf(server))
  const [errors, setErrors] = useState<Errors>({})
  const [test, setTest] = useState<TestState>(() =>
    checkError === undefined
      ? testOf(server)
      : { fresh: false, kind: 'failed', reason: checkError },
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ error: string | null } | null>(null)
  const nextHeaderRef = useRef(0)
  const check = useCheckMcpConfig()
  const save = useSaveMcpServer()
  const remove = useDeleteMcpServer()

  const binding = server === undefined ? undefined : mcpBindingOf(config, server.id)
  const tools = server?.tools ?? []
  const selected = binding === undefined ? [] : selectedMcpTools(binding, server)
  const canSave = test.kind === 'ok' && test.fresh && !save.isPending

  /** 改连接相关的项（地址、连接方式、时限、请求头）后要重新测试；名称与说明不用。 */
  const change = (changes: Partial<Values>, connection: boolean) => {
    setValues((current) => ({ ...current, ...changes }))
    setErrors({})
    setFormError(null)
    if (connection) setTest({ kind: 'none' })
  }
  const changeHeader = (key: string, changes: Partial<HeaderRow>) =>
    change(
      { headers: values.headers.map((row) => (row.key === key ? { ...row, ...changes } : row)) },
      true,
    )

  const checkInput = () => ({
    headers: headersOf(values.headers),
    timeoutSeconds: Number(values.timeout.trim()),
    transport: values.transport,
    url: values.url.trim(),
  })

  const runTest = async () => {
    const found = validate(values, creating)
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return
    setTest({ kind: 'testing' })
    try {
      const result = await check.mutateAsync({ ...checkInput(), serverId: server?.id ?? null })
      setTest(testOfCheck(result, true))
    } catch (error) {
      setTest({ fresh: true, kind: 'failed', reason: errorMessageOf(error, '测试连接失败') })
    }
  }

  const runSave = async () => {
    const found = validate(values, creating)
    setErrors(found)
    if (Object.keys(found).length > 0 || !canSave) return
    setFormError(null)
    const fields = {
      ...checkInput(),
      description: values.description.trim(),
      name: values.name.trim(),
    }
    try {
      const saved = await save.mutateAsync(
        server === undefined
          ? { body: { ...fields, id: values.id.trim() }, kind: 'create' }
          : { body: fields, id: server.id, kind: 'update' },
      )
      const { check: after } = saved
      if (after.kind === 'checked' && after.result.ok) toast.success('MCP 配置已保存')
      else toast.error('MCP 配置已保存，但测试连接失败，请检查配置后重新测试')
      if (creating) {
        // 已经建好：换成这个服务的配置面板，再保存就是修改。试连请求出错时服务上没记结果，原因带过去写在状态行。
        onOpenPanel({
          back,
          checkError: after.kind === 'error' ? after.message : undefined,
          server: saved.server.id,
          type: 'mcp-server',
        })
        return
      }
      // 存好后请求头回到打码值，下次保存前要重新测试。
      setValues(valuesOf(saved.server))
      setTest(
        after.kind === 'error'
          ? { fresh: false, kind: 'failed', reason: after.message }
          : testOfCheck(after.result, false),
      )
    } catch (error) {
      const message = errorMessageOf(error, '保存失败，请重试保存')
      // 新建时标识被占用是 409，写在标识下面。
      if (creating && error instanceof ApiError && error.status === 409) setErrors({ id: message })
      else setFormError(message)
    }
  }

  const runDelete = async () => {
    if (server === undefined) return
    try {
      await remove.mutateAsync(server.id)
      if (binding !== undefined) onChange(unbindMcp(config, server.id))
      toast.success(`已删除 MCP 服务「${server.name}」`)
      onOpenPanel({ type: back ?? 'mcp-library' })
    } catch (error) {
      setDeleting({ error: errorMessageOf(error, '删除失败，请重试删除') })
    }
  }

  const fieldProps = (key: string) =>
    errors[key] === undefined
      ? {}
      : { 'aria-describedby': `${baseId}-${key}-error`, 'aria-invalid': true as const }
  const fieldError = (key: string) =>
    errors[key] === undefined ? null : (
      <span className="text-label text-error" id={`${baseId}-${key}-error`}>
        {errors[key]}
      </span>
    )

  const actions =
    server === undefined ? undefined : (
      <div className="-mr-1 flex items-center gap-1">
        {binding === undefined ? null : (
          <IconButton
            label="从当前 Agent 移除"
            name="delete"
            onClick={() => {
              onChange(unbindMcp(config, server.id))
              onOpenPanel({ type: 'mcp-select' })
            }}
            size="md"
          />
        )}
        <MenuRoot>
          <MenuTrigger asChild>
            <IconButton label="更多操作" name="more" size="md" />
          </MenuTrigger>
          <MenuSurface align="end">
            <MenuItem destructive icon="delete" onSelect={() => setDeleting({ error: null })}>
              删除服务
            </MenuItem>
          </MenuSurface>
        </MenuRoot>
      </div>
    )

  const toolsBlocked =
    binding === undefined ? '当前 Agent 还没有挂这个服务，请先在「管理 MCP 服务」里添加' : undefined

  return (
    <PanelShell
      actions={actions}
      footer={false}
      onClose={onClose}
      title={creating ? '添加 MCP 服务' : '配置 MCP'}
    >
      <div className="flex min-w-0 flex-col gap-4">
        {deleting === null || server === undefined ? null : (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md bg-surface-container-low px-4 py-3"
            role={deleting.error === null ? 'group' : undefined}
            aria-label={deleting.error === null ? '删除确认' : undefined}
          >
            {deleting.error === null ? (
              <p className="min-w-0 flex-1 text-body-sm text-on-surface">
                删除「{server.name}」后所有 Agent 都不能再挂它，且无法恢复。
              </p>
            ) : (
              <p className="min-w-0 flex-1 text-body-sm text-error" role="alert">
                {deleting.error}
              </p>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                disabled={remove.isPending}
                onClick={() => setDeleting(null)}
                size="md"
                variant="ghost"
              >
                {deleting.error === null ? '取消' : '关闭'}
              </Button>
              {deleting.error === null ? (
                <Button
                  loading={remove.isPending}
                  onClick={() => void runDelete()}
                  size="md"
                  variant="danger"
                >
                  删除
                </Button>
              ) : null}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
          <Field label="服务名称" htmlFor={`${baseId}-name`}>
            <Input
              autoComplete="off"
              className={INPUT_CLASS}
              id={`${baseId}-name`}
              maxLength={100}
              onChange={(event) => change({ name: event.currentTarget.value }, false)}
              value={values.name}
              {...fieldProps('name')}
            />
            {fieldError('name')}
          </Field>
          {creating ? (
            <Field label="标识" htmlFor={`${baseId}-id`}>
              <Input
                autoCapitalize="none"
                autoComplete="off"
                className={cn(INPUT_CLASS, 'tabular-nums')}
                id={`${baseId}-id`}
                maxLength={40}
                onChange={(event) => change({ id: event.currentTarget.value }, false)}
                placeholder="team-docs"
                spellCheck={false}
                value={values.id}
                {...fieldProps('id')}
              />
              {fieldError('id')}
            </Field>
          ) : null}
          <Field
            className={creating ? '@min-[440px]:col-span-2' : undefined}
            htmlFor={`${baseId}-description`}
            label="说明"
          >
            <Input
              autoComplete="off"
              className={INPUT_CLASS}
              id={`${baseId}-description`}
              onChange={(event) => change({ description: event.currentTarget.value }, false)}
              value={values.description}
            />
          </Field>
        </div>

        <TabsRoot className="flex min-w-0 flex-col gap-4" defaultValue="connection">
          <TabsList aria-label="MCP 配置类别" className="-ml-2 h-10 border-b border-hairline">
            <TabsTrigger value="connection">连接</TabsTrigger>
            <TabsTrigger
              aria-label={`工具，已启用 ${selected.length} / ${tools.length} 个`}
              value="tools"
            >
              <span className="inline-flex items-center gap-1.5">
                工具
                <CardBadge>
                  {selected.length}/{tools.length}
                </CardBadge>
              </span>
            </TabsTrigger>
          </TabsList>

          <TabsContent className="flex min-w-0 flex-col gap-4" value="connection">
            <Field htmlFor={`${baseId}-url`} label="服务地址">
              <Input
                autoComplete="off"
                className={cn(INPUT_CLASS, 'tabular-nums')}
                id={`${baseId}-url`}
                onChange={(event) => change({ url: event.currentTarget.value }, true)}
                placeholder="https://"
                spellCheck={false}
                type="url"
                value={values.url}
                {...fieldProps('url')}
              />
              {fieldError('url')}
            </Field>
            <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className={LABEL_CLASS}>传输方式</span>
                <Segmented
                  block
                  label="传输方式"
                  onValueChange={(transport) => change({ transport }, true)}
                  options={TRANSPORTS}
                  value={values.transport}
                />
              </div>
              <Field htmlFor={`${baseId}-timeout`} label="超时（秒）">
                <Input
                  className={cn(INPUT_CLASS, 'tabular-nums')}
                  id={`${baseId}-timeout`}
                  inputMode="numeric"
                  onChange={(event) => change({ timeout: event.currentTarget.value }, true)}
                  value={values.timeout}
                  {...fieldProps('timeout')}
                />
                {fieldError('timeout')}
              </Field>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className={LABEL_CLASS}>请求头</span>
                <IconButton
                  disabled={values.headers.length >= MAX_HEADERS}
                  label="添加请求头"
                  name="add"
                  onClick={() => {
                    nextHeaderRef.current += 1
                    change(
                      {
                        headers: [
                          ...values.headers,
                          {
                            key: `new-${nextHeaderRef.current}`,
                            masked: null,
                            name: '',
                            savedName: null,
                            value: '',
                          },
                        ],
                      },
                      true,
                    )
                  }}
                  size="xs"
                  tooltip={
                    values.headers.length >= MAX_HEADERS
                      ? `请求头最多 ${MAX_HEADERS} 个`
                      : undefined
                  }
                />
              </div>
              {values.headers.map((row, index) => (
                <div className="flex min-w-0 flex-col gap-1" key={row.key}>
                  <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
                    <Input
                      aria-label={`请求头名称 ${index + 1}`}
                      autoComplete="off"
                      className={cn(INPUT_CLASS, 'tabular-nums')}
                      onChange={(event) =>
                        changeHeader(row.key, { name: event.currentTarget.value })
                      }
                      placeholder="Authorization"
                      spellCheck={false}
                      value={row.name}
                      {...fieldProps(`header-name-${row.key}`)}
                    />
                    <Input
                      aria-label={`请求头的值 ${index + 1}`}
                      autoComplete="off"
                      className={cn(INPUT_CLASS, 'tabular-nums')}
                      onChange={(event) =>
                        changeHeader(row.key, { value: event.currentTarget.value })
                      }
                      placeholder={row.masked ?? '值'}
                      // 已保存的值只以打码值放在占位里，怎么改写在悬停提示里，不另写一行字。
                      title={row.masked === null ? undefined : '留空就沿用原值，填写新值会替换它'}
                      type="password"
                      value={row.value}
                      {...fieldProps(`header-value-${row.key}`)}
                    />
                    <IconButton
                      label={`移除请求头 ${index + 1}`}
                      name="close"
                      onClick={() =>
                        change(
                          { headers: values.headers.filter((item) => item.key !== row.key) },
                          true,
                        )
                      }
                      size="sm"
                    />
                  </div>
                  {fieldError(`header-name-${row.key}`)}
                  {fieldError(`header-value-${row.key}`)}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <TestStatus test={test} />
              <Button
                disabled={save.isPending || test.kind === 'testing'}
                onClick={() => void runTest()}
                size="md"
                variant="outlined"
              >
                测试连接
              </Button>
              <Button
                disabled={!canSave}
                loading={save.isPending}
                onClick={() => void runSave()}
                size="md"
              >
                保存配置
              </Button>
            </div>
            {formError === null ? null : (
              <p className="text-body-sm text-error" role="alert">
                {formError}
              </p>
            )}
          </TabsContent>

          <TabsContent className="flex min-w-0 flex-col gap-0.5" value="tools">
            {server !== undefined &&
            binding !== undefined &&
            tools.length > 0 &&
            selected.length < tools.length ? (
              <div className="-mt-1 mb-1 flex justify-end">
                <Button
                  onClick={() => onChange(selectAllMcpTools(config, server))}
                  size="md"
                  variant="ghost"
                >
                  全选
                </Button>
              </div>
            ) : null}
            {tools.map((tool) => {
              const on = selected.includes(tool.name)
              const id = `${baseId}-tool-${tool.name}`
              const lastOne = on && selected.length === 1
              return (
                <div
                  className="flex min-h-13 min-w-0 items-center gap-3 rounded-md px-2.5 py-2"
                  key={tool.name}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-on-surface" id={`${id}-name`}>
                      {tool.name}
                    </span>
                    {tool.description === null || tool.description === '' ? null : (
                      <span
                        className="truncate text-label text-on-surface-faint"
                        id={`${id}-description`}
                      >
                        {tool.description}
                      </span>
                    )}
                  </span>
                  <Switch
                    aria-labelledby={`${id}-name`}
                    blockedReason={
                      toolsBlocked ??
                      (lastOne
                        ? '至少保留一个工具；不需要这个服务时请点击「从当前 Agent 移除」'
                        : undefined)
                    }
                    checked={on}
                    onCheckedChange={(next) => {
                      if (server !== undefined)
                        onChange(setMcpTool(config, server, tool.name, next))
                    }}
                  />
                </div>
              )
            })}
            {tools.length === 0 ? (
              <p className="py-8 text-center text-on-surface-faint">
                {creating ? '暂无工具，测试连接通过并保存后列出' : '暂无工具，请先测试连接并保存'}
              </p>
            ) : null}
          </TabsContent>
        </TabsRoot>
      </div>
    </PanelShell>
  )
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

/** 测试连接的结果：通了写耗时，没通写原因；测试中转圈。 */
function TestStatus({ test }: { test: TestState }) {
  return (
    <span
      aria-live="polite"
      className="mr-auto inline-flex min-w-0 items-center gap-1.5 text-label text-on-surface-variant tabular-nums"
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
          <span className="min-w-0 text-error">{test.reason}</span>
        </>
      ) : null}
    </span>
  )
}
