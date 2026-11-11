import { useId, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { Button, IconButton } from '@/shared/ui/button'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { toast } from '@/shared/ui/toast'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'
import type { AgentConfig } from '../agents.api'
import { useMcpAccount, useOnMcpConnected } from '../mcp-account'
import { mcpBindingOf, unbindMcp } from '../mcp-draft'
import {
  checkBody,
  createBody,
  isDirty,
  savedScopeRows,
  scopeRowsOf,
  showsClient,
  testOfCheck,
  testOfServer,
  updateBody,
  validate,
  valuesOf,
  type Errors,
  type HeaderRow,
  type TestState,
  type Values,
} from '../mcp-server-form'
import {
  affectedUsersOf,
  useCheckMcpConfig,
  useCheckMcpServer,
  useDeleteMcpServer,
  useMcpCallbackUrl,
  useMcpServers,
  useSaveMcpServer,
  type McpSaveResult,
  type McpServer,
} from '../mcp-servers.api'
import { AccountCard } from './mcp-account-card'
import {
  ClientCard,
  ConnectionSection,
  HeadersSection,
  IdentityForm,
  IdentityHeader,
  McpTestStatus,
  PerUserCard,
  ScopesSection,
  type FieldErrors,
} from './mcp-server-sections'
import { McpToolsSection } from './mcp-tool-states'
import type { Panel } from './panel'
import { PanelShell } from './panel-shell'

type McpServerPanelProps = {
  serverId: string | null
  back: 'mcp-library' | 'mcp-select' | null
  checkError: string | undefined
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  onOpenPanel: (panel: Panel | null) => void
}

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

type SaveRequest = Parameters<ReturnType<typeof useSaveMcpServer>['mutateAsync']>[0]

const fieldErrorsOf = (baseId: string, errors: Errors): FieldErrors => ({
  error: (key) =>
    errors[key] === undefined ? null : (
      <span className="text-label text-error" id={`${baseId}-${key}-error`}>
        {errors[key]}
      </span>
    ),
  has: (key) => errors[key] !== undefined,
  props: (key) =>
    errors[key] === undefined
      ? {}
      : { 'aria-describedby': `${baseId}-${key}-error`, 'aria-invalid': true as const },
})

const SAVE_FIRST = '请先点击「保存配置」，再测试连接'

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
      ? testOfServer(server)
      : { fresh: false, kind: 'failed', reason: checkError },
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [editingIdentity, setEditingIdentity] = useState(false)
  const [confirm, setConfirm] = useState<{ count: number; request: SaveRequest } | null>(null)
  const [deleting, setDeleting] = useState<{ error: string | null } | null>(null)
  const nextHeaderRef = useRef(0)
  const saveRef = useRef<HTMLButtonElement>(null)
  const testTooltip = useTabTooltip()
  const checkConfig = useCheckMcpConfig()
  const checkServer = useCheckMcpServer()
  const save = useSaveMcpServer()
  const remove = useDeleteMcpServer()

  const perUser = values.authMode === 'per_user'
  const dirty = isDirty(values, server)
  const clientShown = showsClient(values, server)
  const callbackUrl = useMcpCallbackUrl(clientShown)
  const scopeRows = perUser ? scopeRowsOf(values, server) : null
  const binding = server === undefined ? undefined : mcpBindingOf(config, server.id)
  const busy = save.isPending || test.kind === 'testing'
  const testBlocked = perUser && (creating || dirty) ? SAVE_FIRST : undefined
  const canSave = perUser
    ? (creating || dirty) && !save.isPending
    : test.kind === 'ok' && test.fresh && !save.isPending
  const fieldErrors = fieldErrorsOf(baseId, errors)
  const identityAsForm =
    creating || editingIdentity || ['id', 'name', 'url'].some((key) => errors[key] !== undefined)

  const account = useMcpAccount(server)

  const change = (changes: Partial<Values>, connection: boolean) => {
    setValues((current) => ({ ...current, ...changes }))
    setErrors({})
    setFormError(null)
    if (connection) setTest({ kind: 'none' })
  }
  const changeHeader = (key: string, changes: Partial<HeaderRow>) =>
    change(
      { headers: values.headers.map((row) => (row.key === key ? { ...row, ...changes } : row)) },
      Object.keys(changes).some((name) => name !== 'editing'),
    )

  const runTest = async () => {
    if (testBlocked !== undefined) return
    const found = validate(values, creating)
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return
    // 还没连接或连接已失效：先在新窗口里登录，连上后再测（见下面的 useOnMcpConnected）。
    if (perUser && account.connection !== undefined && account.connection.state !== 'connected') {
      account.signIn()
      return
    }
    setTest({ kind: 'testing' })
    try {
      const result =
        perUser && server !== undefined
          ? await checkServer.mutateAsync(server.id)
          : await checkConfig.mutateAsync(checkBody(values, server?.id ?? null))
      setTest(testOfCheck(result, true))
    } catch (error) {
      setTest({ fresh: true, kind: 'failed', reason: errorMessageOf(error, '测试连接失败') })
    }
  }

  useOnMcpConnected(account, () => {
    if (perUser) void runTest()
  })

  const applySaved = (saved: McpSaveResult) => {
    const { check: after } = saved
    if (after.kind === 'error' || (after.kind === 'checked' && !after.result.ok))
      toast.error('MCP 配置已保存，但测试连接失败，请检查配置后重新测试')
    else toast.success('MCP 配置已保存')
    if (creating) {
      onOpenPanel({
        back,
        checkError: after.kind === 'error' ? after.message : undefined,
        server: saved.server.id,
        type: 'mcp-server',
      })
      return
    }
    setValues(valuesOf(saved.server))
    setEditingIdentity(false)
    setTest(
      after.kind === 'error'
        ? { fresh: false, kind: 'failed', reason: after.message }
        : after.kind === 'checked'
          ? testOfCheck(after.result, false)
          : testOfServer(saved.server),
    )
  }

  const send = async (request: SaveRequest) => {
    setFormError(null)
    try {
      applySaved(await save.mutateAsync(request))
    } catch (error) {
      const affected = affectedUsersOf(error)
      if (affected !== null && request.kind === 'update') {
        setConfirm({ count: affected, request })
        return
      }
      const message = errorMessageOf(error, '保存失败，请重试保存')
      if (creating && error instanceof ApiError && error.status === 409 && message.includes('标识'))
        setErrors({ id: message })
      else setFormError(message)
    }
  }

  const runSave = async () => {
    const found = validate(values, creating)
    setErrors(found)
    if (Object.keys(found).length > 0 || !canSave) return
    await send(
      server === undefined
        ? { body: createBody(values), check: !perUser, kind: 'create' }
        : { body: updateBody(values, server), check: !perUser, id: server.id, kind: 'update' },
    )
  }

  const closeConfirm = () => {
    setConfirm(null)
    saveRef.current?.focus()
  }

  const confirmSave = async () => {
    if (confirm === null || confirm.request.kind !== 'update') return
    const { request } = confirm
    closeConfirm()
    await send({ ...request, body: { ...request.body, confirmReconnect: true } })
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

  const footer = (
    <>
      <div className="mr-auto flex min-w-0 flex-1 items-center">
        {formError !== null ? (
          <p className="line-clamp-2 min-w-0 text-body-sm text-error" role="alert">
            {formError}
          </p>
        ) : identityAsForm ? (
          <McpTestStatus test={test} />
        ) : null}
      </div>
      <TooltipRoot {...testTooltip.rootProps} open={testTooltip.rootProps.open && !!testBlocked}>
        <TooltipTrigger asChild {...testTooltip.triggerProps}>
          <Button
            aria-disabled={testBlocked === undefined ? undefined : true}
            // 我的连接还在读时先不让点：读到了才知道是直接测试还是先登录。
            disabled={busy || (perUser && account.reading)}
            onClick={() => void runTest()}
            size="md"
            variant="outlined"
          >
            测试连接
          </Button>
        </TooltipTrigger>
        {testBlocked === undefined ? null : <TooltipContent>{testBlocked}</TooltipContent>}
      </TooltipRoot>
      <PopupRoot
        onOpenChange={(open) => {
          if (!open) closeConfirm()
        }}
        open={confirm !== null}
      >
        <PopupAnchor asChild>
          <Button
            disabled={!canSave}
            loading={save.isPending}
            onClick={() => void runSave()}
            ref={saveRef}
            size="md"
          >
            保存配置
          </Button>
        </PopupAnchor>
        <PopupSurface
          align="end"
          aria-label="保存确认"
          className="flex w-67 flex-col gap-3 p-3"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            closeConfirm()
          }}
          role="dialog"
          side="top"
          sideOffset={8}
        >
          <p className="text-body-sm text-on-surface">
            保存后，已连接的 {confirm?.count ?? 0} 人需要重新连接
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button onClick={closeConfirm} size="md" variant="ghost">
              取消
            </Button>
            <Button onClick={() => void confirmSave()} size="md">
              保存
            </Button>
          </div>
        </PopupSurface>
      </PopupRoot>
    </>
  )

  return (
    <PanelShell
      actions={actions}
      footer={footer}
      onClose={onClose}
      title={creating ? '添加 MCP 服务' : '配置 MCP'}
    >
      <div className="flex min-w-0 flex-col">
        {deleting === null || server === undefined ? null : (
          <div
            aria-label={deleting.error === null ? '删除确认' : undefined}
            className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-surface-container-low px-4 py-3"
            role={deleting.error === null ? 'group' : undefined}
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

        {identityAsForm ? (
          <IdentityForm
            baseId={baseId}
            creating={creating}
            errors={fieldErrors}
            onChange={change}
            values={values}
          />
        ) : (
          <IdentityHeader onEdit={() => setEditingIdentity(true)} test={test} values={values} />
        )}

        <ConnectionSection onChange={change} values={values} />

        <HeadersSection
          errors={fieldErrors}
          onAdd={() => {
            nextHeaderRef.current += 1
            change(
              {
                headers: [
                  ...values.headers,
                  {
                    editing: true,
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
          onChangeRow={changeHeader}
          onRemove={(key) =>
            change({ headers: values.headers.filter((row) => row.key !== key) }, true)
          }
          rows={values.headers}
        />

        <section className="mt-7">
          <PerUserCard
            checked={perUser}
            onCheckedChange={(on) => change({ authMode: on ? 'per_user' : 'shared' }, false)}
          />
          {perUser && server?.authMode === 'per_user' ? (
            <AccountCard
              account={account}
              closedScopes={(savedScopeRows(server) ?? [])
                .filter((row) => !row.on)
                .map((row) => row.name)}
            />
          ) : null}
          {clientShown && server !== undefined ? (
            <ClientCard
              baseId={baseId}
              callbackUrl={callbackUrl.data ?? null}
              maskedSecret={server.oauth.presetClient?.clientSecret ?? null}
              onChange={(changes) => change(changes, false)}
              required={server.oauth.client === 'required'}
              values={values}
            />
          ) : null}
        </section>

        {scopeRows === null ? null : (
          <ScopesSection onChange={(scopes) => change({ scopes }, false)} rows={scopeRows} />
        )}

        <McpToolsSection config={config} creating={creating} onChange={onChange} server={server} />
      </div>
    </PanelShell>
  )
}
