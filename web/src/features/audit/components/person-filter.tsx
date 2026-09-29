/** 按人筛选：工具条右侧的单选菜单，「全部人」加这段时间里出过片或跑过的每个人。 */

import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { Person } from '../audit.api'
import { PickButton } from './overview-toolbar'

type PersonFilterProps = {
  people: readonly Person[]
  /** 选中的用户名；null 是全部人。 */
  value: string | null
  onChange: (userName: string | null) => void
  nameOf: (userName: string) => string | undefined
}

/** 菜单项的值：全部人用空串，Radix 单选组不收 null。 */
const ALL = ''

export function PersonFilter({ people, value, onChange, nameOf }: PersonFilterProps) {
  const label = value === null ? '筛选' : (nameOf(value) ?? value)
  const options = [
    { userName: ALL, label: '全部人' },
    ...people.map(({ userName }) => ({ userName, label: nameOf(userName) ?? userName })),
  ]
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <PickButton
          aria-label={value === null ? '按人筛选' : `按人筛选：${label}`}
          selected={value !== null}
          title="按人筛选"
        >
          <Icon decorative name="filter" size="md" />
          {label}
        </PickButton>
      </MenuTrigger>
      <MenuSurface align="end" className="max-h-90 min-w-42 overflow-y-auto" sideOffset={8}>
        <MenuRadioGroup
          onValueChange={(next) => onChange(next === ALL ? null : next)}
          value={value ?? ALL}
        >
          {options.map((option) => (
            <MenuRadioItem
              className="whitespace-nowrap data-[state=checked]:font-semibold"
              key={option.userName}
              value={option.userName}
            >
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}
