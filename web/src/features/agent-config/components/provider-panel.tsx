import { useId, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { Switch } from '@/shared/ui/switch'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { formatContextSize, maskedCredential } from '../agent-draft'
import {
  useDefaultModels,
  useDeleteCredential,
  useDeleteModel,
  useDeleteProvider,
  useModelProviders,
  useProviderDeclarations,
  usageNames,
  useUpdateModel,
  useUpdateProvider,
  type AgentUsage,
  type Declaration,
  type DefaultModel,
  type ModelProvider,
  type ProviderCredential,
  type ProviderModel,
} from '../model-providers.api'
import { DefaultModels } from './default-models'
import { PanelShell } from './panel-shell'
import { CredentialForm, ModelForm, ProviderCreateForm } from './provider-forms'
import { CardBadge, ResourceCard } from './resource-card'
import { UsageAvatars } from './usage-avatars'

/** 一节的标题行：标题左，图标动作右。 */
function SectionHeading({ action, id, title }: { id: string; title: string; action?: ReactNode }) {
  return (
    <div className="mb-1 flex min-h-8 items-center justify-between gap-3">
      <h3 className="text-body font-semibold text-on-surface" id={id}>
        {title}
      </h3>
      {action === undefined ? null : <div className="-mr-1 flex items-center">{action}</div>}
    </div>
  )
}

/** 行里只表达状态的小图标（内置模型的锁）：名字在可访问名与悬停提示里。 */
function StateGlyph({ label, name }: { label: string; name: 'locked' | 'link' }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span className="inline-grid shrink-0 place-items-center text-on-surface-faint">
          <Icon label={label} name={name} size="xs" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  )
}

/** 被后端拦下的原因（含被引用时的 409），就地写在出问题的那一行下面，下一次操作前收起。 */
function RowAlert({ message }: { message: string }) {
  return (
    <p className="px-2.5 pb-2 text-body-sm text-error" role="alert">
      {message}
    </p>
  )
}

/** 列表里的一行：名字、小件、右侧的动作与开关；动作在悬停或聚焦时出现，触屏上常显。 */
function Row({ children, error }: { children: ReactNode; error: string | undefined }) {
  return (
    <li className="group flex flex-col border-t border-hairline first:border-t-0">
      <div className="flex min-h-12 min-w-0 items-center gap-2 rounded-sm pr-1 pl-2.5">
        {children}
      </div>
      {error === undefined ? null : <RowAlert message={error} />}
    </li>
  )
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="mr-1.5 flex shrink-0 items-center opacity-0 transition-opacity ui-motion-s group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100">
      {children}
    </span>
  )
}

/** 同一个 agent 只算一次，按标识排（合同 §19「被引用时拦住」）。 */
const uniqueUsers = (lists: readonly (readonly AgentUsage[])[]): AgentUsage[] => {
  const byId = new Map<string, AgentUsage>()
  for (const user of lists.flat()) byId.set(user.agentId, user)
  return [...byId.values()].sort((a, b) => (a.agentId < b.agentId ? -1 : 1))
}

const isDefaultModel = (
  defaults: readonly DefaultModel[],
  provider: ModelProvider,
  model: ProviderModel,
) =>
  defaults.some(
    (item) =>
      item.providerId === provider.id && item.type === model.type && item.modelName === model.name,
  )

type Editor =
  | { kind: 'model'; model: ProviderModel | null }
  | { kind: 'credential'; credential: ProviderCredential | null }
  | null

/**
 * 选中的供应商：显示名就地改，默认密钥的接口地址，在用的 agent、删除与启停；下面是它的模型与密钥，
 * 添加与修改在各自一节里就地展开。在用、是默认的项不能停用或删除，原因在悬停提示里；后端仍拦下时原因写在那一行下面。
 */
function ProviderDetail({
  addKey,
  declaration,
  defaults,
  onDeleted,
  provider,
}: {
  /** 刚建好的供应商：一打开就展开「添加密钥」。 */
  addKey: boolean
  provider: ModelProvider
  declaration: Declaration | undefined
  defaults: readonly DefaultModel[]
  onDeleted: () => void
}) {
  const baseId = useId()
  const updateProvider = useUpdateProvider()
  const deleteProvider = useDeleteProvider()
  const updateModel = useUpdateModel()
  const deleteModel = useDeleteModel()
  const deleteCredential = useDeleteCredential()
  const [editor, setEditor] = useState<Editor>(
    addKey ? { credential: null, kind: 'credential' } : null,
  )
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null)
  const [label, setLabel] = useState<string | null>(null)

  const errorFor = (key: string) => (rowError?.key === key ? rowError.message : undefined)
  const run = async (key: string, fallback: string, action: () => Promise<unknown>) => {
    setRowError(null)
    try {
      await action()
    } catch (error) {
      setRowError({ key, message: errorMessageOf(error, fallback) })
    }
  }

  const users = uniqueUsers([
    ...provider.models.map((model) => model.usedBy),
    ...provider.credentials.map((credential) => credential.usedBy),
  ])
  const holdsDefault = defaults.some((item) => item.providerId === provider.id)
  const defaultCredential = provider.credentials.find(
    (item) => item.id === provider.defaultCredentialId,
  )
  const baseUrl = defaultCredential?.fields['base_url']
  const deleteBlocked =
    users.length > 0
      ? `${usageNames(users)}正在使用，不能删除`
      : holdsDefault
        ? '默认模型在这个供应商里，请先在「默认模型」里换掉'
        : undefined

  const commitLabel = () => {
    const next = label?.trim()
    if (next === undefined) return
    if (next === '' || next === provider.label) {
      setLabel(null)
      return
    }
    void run('provider', '显示名保存失败，请重试', async () => {
      await updateProvider.mutateAsync({ changes: { label: next }, id: provider.id })
      setLabel(null)
    })
  }

  return (
    <>
      <div className="mt-5 flex min-w-0 items-center gap-1 border-b border-hairline pb-5">
        <div className="-ml-2 flex min-w-0 flex-1 flex-col gap-0.5">
          <input
            aria-label="供应商显示名"
            className="w-full min-w-0 rounded-sm bg-transparent px-2 py-0.5 text-title font-semibold text-on-surface transition-colors ui-motion-s hover:bg-state-hover focus:bg-state-hover focus-visible:outline-0"
            maxLength={50}
            onBlur={commitLabel}
            onChange={(event) => setLabel(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            value={label ?? provider.label}
          />
          {baseUrl === undefined ? null : (
            <span className="flex min-w-0 items-center gap-1.5 px-2 text-label text-on-surface-faint tabular-nums">
              <StateGlyph label="接口地址" name="link" />
              <span className="truncate">{baseUrl}</span>
            </span>
          )}
        </div>
        <span className="mr-2 flex">
          <UsageAvatars users={users} />
        </span>
        <IconButton
          disabled={deleteBlocked !== undefined || deleteProvider.isPending}
          label="删除供应商"
          name="delete"
          onClick={() =>
            void run('provider', '供应商删除失败，请重试', async () => {
              await deleteProvider.mutateAsync(provider.id)
              onDeleted()
            })
          }
          size="sm"
          tooltip={deleteBlocked}
        />
        <Switch
          aria-label={`启用供应商 ${provider.label}`}
          blockedReason={
            provider.enabled && users.length > 0
              ? `${usageNames(users)}正在使用，不能停用`
              : undefined
          }
          checked={provider.enabled}
          className="ml-2"
          disabled={updateProvider.isPending}
          onCheckedChange={(enabled) =>
            void run('provider', '供应商保存失败，请重试', () =>
              updateProvider.mutateAsync({ changes: { enabled }, id: provider.id }),
            )
          }
        />
      </div>
      {errorFor('provider') === undefined ? null : (
        <RowAlert message={errorFor('provider') ?? ''} />
      )}

      <section aria-labelledby={`${baseId}-models`} className="mt-7">
        <SectionHeading
          action={
            declaration?.customModels === true ? (
              <IconButton
                label="添加模型"
                name="add"
                onClick={() => setEditor({ kind: 'model', model: null })}
                size="sm"
              />
            ) : undefined
          }
          id={`${baseId}-models`}
          title="模型"
        />
        <ul className="flex flex-col">
          {provider.models.map((model) => {
            const key = `model:${model.type}:${model.name}`
            const isDefault = isDefaultModel(defaults, provider, model)
            const blocked =
              model.usedBy.length > 0
                ? `${usageNames(model.usedBy)}正在使用`
                : isDefault
                  ? `它是 ${model.type} 的默认模型`
                  : undefined
            const saving =
              updateModel.isPending &&
              updateModel.variables.model.type === model.type &&
              updateModel.variables.model.name === model.name
            return (
              <Row error={errorFor(key)} key={key}>
                <span
                  className={cn(
                    'min-w-0 truncate text-label text-on-surface tabular-nums',
                    !model.enabled && 'text-disabled-text',
                  )}
                >
                  {model.name}
                </span>
                {model.contextSize === null ? null : (
                  <CardBadge>{formatContextSize(model.contextSize)}</CardBadge>
                )}
                {model.type === 'llm' ? null : <CardBadge>{model.type}</CardBadge>}
                {model.source === 'declared' ? <StateGlyph label="内置模型" name="locked" /> : null}
                <span className="flex-1" />
                <UsageAvatars users={model.usedBy} />
                {model.source === 'custom' ? (
                  <RowActions>
                    {model.type === 'llm' ? (
                      <IconButton
                        label={`编辑模型 ${model.name}`}
                        name="edit"
                        onClick={() => setEditor({ kind: 'model', model })}
                        size="xs"
                      />
                    ) : null}
                    <IconButton
                      disabled={blocked !== undefined}
                      label={`删除模型 ${model.name}`}
                      name="delete"
                      onClick={() =>
                        void run(key, '模型删除失败，请重试', () =>
                          deleteModel.mutateAsync({ model, providerId: provider.id }),
                        )
                      }
                      size="xs"
                      tooltip={
                        blocked === undefined
                          ? undefined
                          : `${blocked}，不能删除${isDefault && model.usedBy.length === 0 ? '；请先在「默认模型」里换掉' : ''}`
                      }
                    />
                  </RowActions>
                ) : null}
                <Switch
                  aria-label={`启用模型 ${model.name}`}
                  blockedReason={
                    model.enabled && blocked !== undefined
                      ? `${blocked}，不能停用${isDefault && model.usedBy.length === 0 ? '；请先在「默认模型」里换掉' : ''}`
                      : undefined
                  }
                  checked={model.enabled}
                  disabled={saving}
                  onCheckedChange={(enabled) =>
                    void run(key, '模型保存失败，请重试', () =>
                      updateModel.mutateAsync({
                        changes: { enabled },
                        model,
                        providerId: provider.id,
                      }),
                    )
                  }
                />
              </Row>
            )
          })}
        </ul>
        {editor?.kind === 'model' ? (
          <ModelForm
            key={editor.model?.name ?? ''}
            model={editor.model}
            onDone={() => setEditor(null)}
            provider={provider}
          />
        ) : null}
      </section>

      <section aria-labelledby={`${baseId}-credentials`} className="mt-7">
        <SectionHeading
          action={
            <IconButton
              label="添加密钥"
              name="add"
              onClick={() => setEditor({ credential: null, kind: 'credential' })}
              size="sm"
            />
          }
          id={`${baseId}-credentials`}
          title="密钥"
        />
        {provider.credentials.length === 0 ? (
          <p className="px-2.5 py-3 text-body-sm text-on-surface-faint">
            暂无密钥，请点击「添加密钥」接入
          </p>
        ) : null}
        <ul className="flex flex-col">
          {provider.credentials.map((credential) => {
            const key = `credential:${credential.id}`
            const isDefault = credential.id === provider.defaultCredentialId
            const masked = maskedCredential(credential.fields)
            const deleteReason = isDefault
              ? '默认密钥不能删除，请先把另一把设为默认'
              : credential.usedBy.length > 0
                ? `${usageNames(credential.usedBy)}正在使用，不能删除`
                : undefined
            return (
              <Row error={errorFor(key)} key={credential.id}>
                <Icon
                  className="shrink-0 text-on-surface-faint"
                  decorative
                  name="credential"
                  size="sm"
                />
                <span className="min-w-0 truncate text-body text-on-surface">
                  {credential.name}
                </span>
                {masked === null ? null : (
                  <span className="inline-flex h-4.5 shrink-0 items-center rounded-xs bg-state-active px-1.5 text-caption text-on-surface-variant tabular-nums">
                    {masked}
                  </span>
                )}
                {isDefault ? <CardBadge>默认</CardBadge> : null}
                <span className="flex-1" />
                <UsageAvatars users={credential.usedBy} />
                <RowActions>
                  {isDefault ? null : (
                    <IconButton
                      label={`把 ${credential.name} 设为默认密钥`}
                      name="make-default"
                      onClick={() =>
                        void run(key, '默认密钥设置失败，请重试', () =>
                          updateProvider.mutateAsync({
                            changes: { defaultCredentialId: credential.id },
                            id: provider.id,
                          }),
                        )
                      }
                      size="xs"
                    />
                  )}
                  <IconButton
                    label={`编辑密钥 ${credential.name}`}
                    name="edit"
                    onClick={() => setEditor({ credential, kind: 'credential' })}
                    size="xs"
                  />
                  <IconButton
                    disabled={deleteReason !== undefined}
                    label={`删除密钥 ${credential.name}`}
                    name="delete"
                    onClick={() =>
                      void run(key, '密钥删除失败，请重试', () =>
                        deleteCredential.mutateAsync({
                          id: credential.id,
                          providerId: provider.id,
                        }),
                      )
                    }
                    size="xs"
                    tooltip={deleteReason}
                  />
                </RowActions>
              </Row>
            )
          })}
        </ul>
        {editor?.kind === 'credential' ? (
          <CredentialForm
            credential={editor.credential}
            declaration={declaration}
            key={editor.credential?.id ?? ''}
            onDone={() => setEditor(null)}
            provider={provider}
          />
        ) : null}
      </section>
    </>
  )
}

/**
 * 「模型与供应商」：供应商卡片（模型数、密钥数），选中的供应商的详情、模型与密钥，最后是各类型的默认模型。
 * 只在持 `model:manage` 时打开。任何修改后 agent 的「模型设置」随之重读。
 */
export function ProviderPanel({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const providers = useModelProviders()
  const declarations = useProviderDeclarations()
  const defaults = useDefaultModels()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // 刚建好的供应商：选中它时直接展开「添加密钥」。
  const [addKeyFor, setAddKeyFor] = useState<string | null>(null)

  const list = providers.data ?? []
  const selected = list.find((item) => item.id === selectedId) ?? list[0]

  return (
    <PanelShell onClose={onClose} title="模型与供应商">
      {providers.isPending ? (
        <ListPending label="正在读取供应商…" />
      ) : providers.isError ? (
        <ListError message={providers.error.message} onRetry={() => void providers.refetch()} />
      ) : (
        <>
          <section aria-labelledby={titleId}>
            <SectionHeading
              action={
                <IconButton
                  disabled={creating || declarations.data === undefined}
                  label="添加供应商"
                  name="add"
                  onClick={() => setCreating(true)}
                  size="sm"
                />
              }
              id={titleId}
              title="供应商"
            />
            <div className="mt-1.5 grid grid-cols-1 gap-2 @min-[440px]:grid-cols-2">
              {list.map((provider) => (
                <ResourceCard
                  active={!creating && provider.id === selected?.id}
                  icon="provider"
                  key={provider.id}
                  label={`供应商：${provider.label}`}
                  muted={!provider.enabled}
                  name={provider.label}
                  onOpen={() => {
                    setCreating(false)
                    setAddKeyFor(null)
                    setSelectedId(provider.id)
                  }}
                  tip={`${provider.label}：${provider.models.length} 个模型，${provider.credentials.length} 把密钥${provider.enabled ? '' : '，已停用'}`}
                  trailing={
                    <>
                      <CardBadge icon="model">{provider.models.length}</CardBadge>
                      <CardBadge icon="credential">{provider.credentials.length}</CardBadge>
                    </>
                  }
                />
              ))}
            </div>
          </section>

          {creating ? (
            <ProviderCreateForm
              declarations={declarations.data ?? []}
              onCancel={() => setCreating(false)}
              onCreated={(providerId) => {
                setCreating(false)
                setSelectedId(providerId)
                setAddKeyFor(providerId)
              }}
            />
          ) : selected === undefined ? (
            <p className="py-8 text-center text-on-surface-faint">
              暂无供应商，请点击「添加供应商」接入
            </p>
          ) : (
            <ProviderDetail
              addKey={addKeyFor === selected.id}
              declaration={declarations.data?.find((item) => item.name === selected.provider)}
              defaults={defaults.data ?? []}
              key={selected.id}
              onDeleted={() => setSelectedId(null)}
              provider={selected}
            />
          )}

          <DefaultModels defaults={defaults.data ?? []} providers={list} />
        </>
      )}
    </PanelShell>
  )
}
