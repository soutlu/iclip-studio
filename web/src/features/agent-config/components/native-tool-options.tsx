import { useId } from 'react'
import { Switch } from '@/shared/ui/switch'
import {
  nativeToolBlocked,
  setNativeTool,
  type NativeTool,
  type NativeToolName,
} from '../native-tools'

/**
 * 「原生工具」一组开关：列出 `offered` 里的工具，外加已开着但已不在其中的（好让人关掉）；
 * 一个都不列时不渲染。依赖没全开的工具开不了，关掉被依赖的会连带关掉依赖它的。
 */
export function NativeToolOptions({
  catalog,
  className,
  disabled = false,
  offered,
  onChange,
  value,
}: {
  catalog: readonly NativeTool[]
  offered: readonly NativeToolName[]
  value: readonly NativeToolName[]
  onChange: (value: NativeToolName[]) => void
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const tools = catalog.filter((tool) => offered.includes(tool.name) || value.includes(tool.name))
  if (tools.length === 0) return null
  return (
    <div aria-labelledby={id} className={className} role="group">
      <span className="text-label font-medium text-on-surface-variant" id={id}>
        原生工具
      </span>
      <ul className="mt-3 flex flex-col gap-2">
        {tools.map((tool) => {
          const on = value.includes(tool.name)
          return (
            <li className="flex items-center justify-between gap-3" key={tool.name}>
              <span className="text-label text-on-surface" id={`${id}-${tool.name}`}>
                {tool.label}
              </span>
              <Switch
                aria-labelledby={`${id}-${tool.name}`}
                checked={on}
                disabled={disabled || (!on && nativeToolBlocked(tool, value))}
                onCheckedChange={(next) => onChange(setNativeTool(catalog, value, tool.name, next))}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
