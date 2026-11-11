import { useId, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { enabledPluginNames, missingRequiresReason, setPluginEnabled } from '../agent-draft'
import type { AgentConfig, AgentPlugin } from '../agents.api'
import { pluginIcon } from '../plugin-icons'
import { PanelShell } from './panel-shell'
import {
  AlertGlyph,
  CARD_SWITCH_HIT,
  DIRECTORY_CARD,
  DIRECTORY_GRID,
  DirectoryCardBody,
} from './resource-card'

export function PluginPanel({
  config,
  onChange,
  onClose,
  plugins,
}: {
  config: AgentConfig
  plugins: readonly AgentPlugin[]
  onChange: (config: AgentConfig) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const baseId = useId()
  const enabled = enabledPluginNames(config)
  const registry = plugins.map((plugin) => plugin.name)
  const keyword = query.trim().toLowerCase()
  const matches = plugins.filter((plugin) =>
    `${plugin.label} ${plugin.description} ${plugin.name}`.toLowerCase().includes(keyword),
  )
  return (
    <PanelShell onClose={onClose} title="插件">
      <Input
        aria-label="搜索插件"
        leadingIcon="search"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索插件"
        type="search"
        value={query}
        wrapperClassName="mb-4 h-(--control-height-md) rounded-sm border-transparent bg-surface-container-low focus-within:border-transparent"
      />
      <ul className={DIRECTORY_GRID}>
        {matches.map((plugin) => {
          const on = enabled.includes(plugin.name)
          const missing = on ? missingRequiresReason(plugin, enabled, plugins) : undefined
          const id = `${baseId}-${plugin.name}`
          return (
            <li className={cn(DIRECTORY_CARD, 'bg-background')} key={plugin.name}>
              <DirectoryCardBody
                badges={missing === undefined ? undefined : <AlertGlyph reason={missing} />}
                description={plugin.description}
                descriptionId={`${id}-description`}
                icon={pluginIcon(plugin.name)}
                name={plugin.label}
                nameId={`${id}-name`}
                trailing={
                  <Switch
                    aria-describedby={`${id}-description`}
                    aria-labelledby={`${id}-name`}
                    checked={on}
                    className={CARD_SWITCH_HIT}
                    onCheckedChange={(next) =>
                      onChange(setPluginEnabled(config, plugin.name, next, registry))
                    }
                  />
                }
              />
            </li>
          )
        })}
      </ul>
      {matches.length === 0 ? (
        <p className="py-8 text-center text-on-surface-faint">
          {plugins.length === 0 ? '暂无可用插件' : '没有匹配的插件'}
        </p>
      ) : null}
    </PanelShell>
  )
}
