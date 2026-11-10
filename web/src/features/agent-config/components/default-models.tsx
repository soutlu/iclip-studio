import { useId, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { MODEL_KIND_LABEL, MODEL_KINDS } from '../model-kinds'
import {
  useSetDefaultModel,
  type DefaultModel,
  type ModelProvider,
  type ModelType,
} from '../model-providers.api'
import { SectionHeading } from './section-heading'

const optionKey = (providerId: string, modelName: string) => `${providerId}\u0000${modelName}`

export function DefaultModels({
  defaults,
  providers,
}: {
  providers: readonly ModelProvider[]
  defaults: readonly DefaultModel[]
}) {
  const titleId = useId()
  const setDefault = useSetDefaultModel()
  const [error, setError] = useState<{ type: ModelType; message: string } | null>(null)

  const choose = async (type: ModelType, providerId: string, modelName: string) => {
    setError(null)
    try {
      await setDefault.mutateAsync({ modelName, providerId, type })
    } catch (cause) {
      setError({ message: errorMessageOf(cause, '默认模型设置失败，请重试'), type })
    }
  }

  return (
    <section aria-labelledby={titleId} className="mt-7">
      <SectionHeading id={titleId} note="没有单独指定模型时使用" title="默认模型" />
      {MODEL_KINDS.map((type) => {
        const kind = MODEL_KIND_LABEL[type]
        const current = defaults.find((item) => item.type === type)
        const owner = providers.find((item) => item.id === current?.providerId)
        const options = providers
          .filter((provider) => provider.enabled)
          .flatMap((provider) =>
            provider.models
              .filter((model) => model.type === type && model.enabled)
              .map((model) => ({ model, provider })),
          )
        const shown =
          current === undefined
            ? '未设置'
            : `${owner?.label ?? current.providerName} ${current.modelName}`
        return (
          <div className="border-b border-hairline last:border-b-0" key={type}>
            <div className="flex min-h-13 items-center justify-between gap-4">
              <span className="text-body text-on-surface">{kind}</span>
              <MenuRoot>
                <MenuTrigger
                  aria-label={`${kind}默认模型：${shown}`}
                  className="inline-flex h-(--control-height-md) max-w-72 min-w-0 ui-state cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-body-sm text-on-surface ring-1 ring-border ui-focus ring-inset data-[state=open]:bg-state-active"
                  disabled={setDefault.isPending}
                >
                  <Icon className="text-on-surface-faint" decorative name="provider" size="sm" />
                  <span className="min-w-0 truncate tabular-nums">
                    {current?.modelName ?? '未设置'}
                  </span>
                  <Icon className="text-on-surface-faint" decorative name="expand" size="sm" />
                </MenuTrigger>
                <MenuSurface align="end" className="max-w-80 min-w-60">
                  {options.length === 0 ? (
                    <p className="px-2 py-1.5 text-label text-on-surface-faint">
                      暂无启用的{kind}模型
                    </p>
                  ) : (
                    <MenuRadioGroup
                      onValueChange={(value) => {
                        const picked = options.find(
                          (option) => optionKey(option.provider.id, option.model.name) === value,
                        )
                        if (picked !== undefined)
                          void choose(type, picked.provider.id, picked.model.name)
                      }}
                      value={
                        current === undefined
                          ? ''
                          : optionKey(current.providerId, current.modelName)
                      }
                    >
                      {options.map(({ model, provider }) => (
                        <MenuRadioItem
                          key={optionKey(provider.id, model.name)}
                          value={optionKey(provider.id, model.name)}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="min-w-0 flex-1 truncate tabular-nums">
                              {model.name}
                            </span>
                            <span className="shrink-0 text-label text-on-surface-variant">
                              {provider.label}
                            </span>
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  )}
                </MenuSurface>
              </MenuRoot>
            </div>
            {error?.type === type ? (
              <p className="pb-2 text-body-sm text-error" role="alert">
                {error.message}
              </p>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
