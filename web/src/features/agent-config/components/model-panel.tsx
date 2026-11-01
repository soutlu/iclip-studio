import { RadioGroup } from 'radix-ui'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import {
  THINKING_LEVELS,
  ThinkingEmoji,
  thinkingLabel,
  type ThinkingLevel,
} from '@/shared/ui/thinking-level'
import {
  chooseModel,
  formatContextSize,
  maskedCredential,
  setCredential,
  setThinking,
} from '../agent-draft'
import type { AgentConfig, ProviderOption } from '../agents.api'
import { PanelShell } from './panel-shell'
import { CardBadge } from './resource-card'
import { Segmented } from './segmented'

const DEFAULT_CREDENTIAL = 'default'

const modelKey = (provider: string, model: string) => `${provider}\u0000${model}`

/** 给当前 agent 选供应商下的对话模型、思考档位与密钥；只列启用的（合同 §19「选模型」）。 */
export function ModelPanel({
  config,
  onChange,
  onClose,
  providers,
}: {
  config: AgentConfig
  providers: readonly ProviderOption[]
  onChange: (config: AgentConfig) => void
  onClose: () => void
}) {
  const current = config.model ?? null
  const provider = providers.find((item) => item.name === current?.provider)
  const model = provider?.models.find((item) => item.name === current?.name)
  const levels = THINKING_LEVELS.filter((level) => model?.thinking.includes(level))
  const defaultCredential = provider?.credentials.find((item) => item.isDefault)
  const credentialId = current?.credential_id ?? null
  const credential =
    credentialId === null
      ? defaultCredential
      : provider?.credentials.find((item) => item.id === credentialId)
  const maskOf = (fields: Record<string, string> | undefined) =>
    fields === undefined ? '' : (maskedCredential(fields) ?? '')

  return (
    <PanelShell onClose={onClose} title="模型设置">
      <RadioGroup.Root
        aria-label="模型"
        className="flex flex-col gap-4"
        onValueChange={(key) => {
          for (const option of providers) {
            const picked = option.models.find((item) => modelKey(option.name, item.name) === key)
            if (picked !== undefined) return onChange(chooseModel(config, option, picked))
          }
        }}
        value={current === null ? '' : modelKey(current.provider, current.name)}
      >
        {providers.map((option) =>
          option.models.length === 0 ? null : (
            <div className="flex flex-col gap-0.5" key={option.id}>
              <p className="flex h-7 items-center gap-2 px-2.5 text-label font-medium text-on-surface-variant">
                <Icon decorative name="provider" size="sm" />
                {option.label}
              </p>
              {option.models.map((item) => (
                <RadioGroup.Item
                  className={cn(
                    'group flex min-h-10 ui-state cursor-pointer items-center gap-2 rounded-sm px-2.5 text-left text-label text-on-surface tabular-nums ui-focus',
                    'data-[state=checked]:bg-state-active data-[state=checked]:font-medium',
                  )}
                  key={item.name}
                  value={modelKey(option.name, item.name)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.contextSize === null ? null : (
                    <CardBadge>{formatContextSize(item.contextSize)}</CardBadge>
                  )}
                  <Icon
                    className="opacity-0 group-data-[state=checked]:opacity-100"
                    decorative
                    name="check"
                    size="md"
                  />
                </RadioGroup.Item>
              ))}
            </div>
          ),
        )}
      </RadioGroup.Root>

      <div className="mt-6 flex flex-col border-t border-hairline">
        <div className="flex min-h-14 items-center justify-between gap-4 border-b border-hairline px-2.5">
          <span className="font-medium text-on-surface-variant">思考</span>
          {levels.length > 0 ? (
            <Segmented<ThinkingLevel>
              label="思考档位"
              onValueChange={(level) => onChange(setThinking(config, level))}
              options={levels.map((level) => ({
                icon: <ThinkingEmoji level={level} />,
                label: thinkingLabel(level),
                value: level,
              }))}
              value={current?.settings?.thinking ?? null}
            />
          ) : (
            // 模型不能设档位（或还没选模型）：按模型自己的默认来。
            <Segmented
              disabled
              label="思考档位"
              onValueChange={() => {}}
              options={[{ label: '默认', value: 'default' }]}
              value="default"
            />
          )}
        </div>
        <div className="flex min-h-14 items-center justify-between gap-4 border-b border-hairline px-2.5">
          <span className="font-medium text-on-surface-variant">密钥</span>
          <MenuRoot>
            <MenuTrigger
              aria-label={`密钥：${credentialId === null ? '默认' : (credential?.name ?? '未设置')}`}
              className="inline-flex h-(--control-height-md) max-w-60 ui-state cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-body-sm text-on-surface ring-1 ring-border ui-focus ring-inset data-[state=open]:bg-state-active"
              disabled={provider === undefined}
            >
              <Icon className="text-on-surface-faint" decorative name="credential" size="sm" />
              <span className="min-w-0 truncate tabular-nums">
                {maskOf(credential?.fields) || credential?.name || '未设置'}
              </span>
              {credentialId === null ? <CardBadge>默认</CardBadge> : null}
              <Icon className="text-on-surface-faint" decorative name="expand" size="sm" />
            </MenuTrigger>
            <MenuSurface align="end" className="min-w-60">
              <MenuRadioGroup
                onValueChange={(value) =>
                  onChange(setCredential(config, value === DEFAULT_CREDENTIAL ? null : value))
                }
                value={credentialId ?? DEFAULT_CREDENTIAL}
              >
                <MenuRadioItem value={DEFAULT_CREDENTIAL}>
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex-1">默认</span>
                    <span className="text-label text-on-surface-variant tabular-nums">
                      {maskOf(defaultCredential?.fields)}
                    </span>
                  </span>
                </MenuRadioItem>
                <MenuSeparator />
                {(provider?.credentials ?? []).map((item) => (
                  <MenuRadioItem key={item.id} value={item.id}>
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="text-label text-on-surface-variant tabular-nums">
                        {maskOf(item.fields)}
                      </span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        </div>
      </div>
    </PanelShell>
  )
}
