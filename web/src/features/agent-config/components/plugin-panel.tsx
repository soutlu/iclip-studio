import { useId, useState } from 'react'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { enabledPluginNames, missingRequiresReason, setPluginEnabled } from '../agent-draft'
import type { AgentConfig, AgentPlugin } from '../agents.api'
import { pluginIcon } from '../plugin-icons'
import { PanelShell } from './panel-shell'
import { AlertGlyph, CardGlyph } from './resource-card'

/** 本部署的全部插件，一行一个开关；开关只改这一个插件，缺的依赖标红、留给发布检查。 */
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
      {/* 搜索框是浅灰底、不描边，聚焦也不出框，光标就是指示（同 v17 的目录搜索）。 */}
      <Input
        aria-label="搜索插件"
        leadingIcon="search"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索插件"
        type="search"
        value={query}
        wrapperClassName="mb-4 h-(--control-height-md) rounded-sm border-transparent bg-surface-container-low focus-within:border-transparent"
      />
      <ul className="grid grid-cols-1 gap-x-3 gap-y-1 @min-[560px]:grid-cols-2">
        {matches.map((plugin) => {
          const on = enabled.includes(plugin.name)
          const missing = on ? missingRequiresReason(plugin, enabled, plugins) : undefined
          const id = `${baseId}-${plugin.name}`
          return (
            <li
              className="flex min-h-15 min-w-0 items-center gap-3 rounded-md p-2.5"
              key={plugin.name}
            >
              <CardGlyph
                className="size-9 bg-surface-container-low"
                name={pluginIcon(plugin.name)}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-on-surface">
                  <span className="truncate" id={`${id}-name`}>
                    {plugin.label}
                  </span>
                  {missing === undefined ? null : <AlertGlyph reason={missing} />}
                </span>
                <span
                  className="truncate text-label text-on-surface-faint"
                  id={`${id}-description`}
                >
                  {plugin.description}
                </span>
              </span>
              <Switch
                aria-describedby={`${id}-description`}
                aria-labelledby={`${id}-name`}
                checked={on}
                onCheckedChange={(next) =>
                  onChange(setPluginEnabled(config, plugin.name, next, registry))
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
