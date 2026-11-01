import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import type { Skill } from '../agents.api'
import { PanelShell } from './panel-shell'
import { CardBadge, CardGlyph } from './resource-card'

type SkillListPanelProps = {
  /** `library` 点一行编辑这个技能；`catalog` 点一行给当前 Agent 添加或去掉它。 */
  mode: 'library' | 'catalog'
  skills: readonly Skill[]
  /** 当前 Agent 草稿里绑定的技能。 */
  boundIds: readonly string[]
  onToggle: (skill: Skill) => void
  onOpen: (skill: Skill) => void
  onCreate: () => void
  onClose: () => void
}

/**
 * 技能库与「添加技能」共用的列表：搜索、「新建技能」，一行一个技能（图标、名字、一句说明），从没发布过的带「草稿」。
 * 选技能时右侧是 + / ✓；从没发布过的技能不能绑定，点了进它的编辑器，发布后再来添加。
 */
export function SkillListPanel({
  boundIds,
  mode,
  onClose,
  onCreate,
  onOpen,
  onToggle,
  skills,
}: SkillListPanelProps) {
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  // 已归档的不再列出；选技能时还绑着的照样列出来，好去掉它。
  const listed = skills.filter(
    (skill) => skill.status === 'active' || (mode === 'catalog' && boundIds.includes(skill.id)),
  )
  const matches = listed.filter((skill) =>
    `${skill.displayName} ${skill.description} ${skill.name}`.toLowerCase().includes(keyword),
  )
  return (
    <PanelShell onClose={onClose} title={mode === 'library' ? '技能库' : '添加技能'}>
      <div className="mb-4 flex items-center gap-2">
        {/* 搜索框是浅灰底、不描边，聚焦也不出框（同插件面板）。 */}
        <Input
          aria-label="搜索技能"
          leadingIcon="search"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索技能"
          type="search"
          value={query}
          wrapperClassName="h-(--control-height-md) min-w-0 flex-1 rounded-sm border-transparent bg-surface-container-low focus-within:border-transparent"
        />
        <Button leadingIcon="add" onClick={onCreate} size="md" variant="outlined">
          新建技能
        </Button>
      </div>
      <ul className="grid grid-cols-1 gap-x-3 gap-y-1 @min-[560px]:grid-cols-2">
        {matches.map((skill) => {
          const draftOnly = skill.latestVersion === null
          const bound = boundIds.includes(skill.id)
          // 选技能时，没发布过、也没绑着的那一行点了是进编辑器。
          const opens = mode === 'library' || (draftOnly && !bound)
          return (
            <li className="min-w-0" key={skill.id}>
              <button
                aria-label={opens ? `编辑技能：${skill.displayName}` : skill.displayName}
                aria-pressed={opens ? undefined : bound}
                className="flex min-h-15 w-full min-w-0 ui-state cursor-pointer items-center gap-3 rounded-md p-2.5 text-left ui-focus"
                onClick={() => (opens ? onOpen(skill) : onToggle(skill))}
                type="button"
              >
                <CardGlyph className="size-9 bg-surface-container-low" name="skill" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-on-surface">{skill.displayName}</span>
                  <span className="truncate text-label text-on-surface-faint">
                    {skill.description}
                  </span>
                </span>
                <span
                  className={cn(
                    'grid min-w-6 shrink-0 place-items-center text-on-surface-faint',
                    bound && 'text-on-surface',
                  )}
                >
                  {draftOnly ? (
                    <CardBadge>草稿</CardBadge>
                  ) : mode === 'library' ? (
                    <Icon decorative name="disclosure" size="sm" />
                  ) : (
                    <Icon decorative name={bound ? 'check' : 'add'} size="sm" />
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {matches.length === 0 ? (
        <p className="py-8 text-center text-on-surface-faint">
          {listed.length === 0 ? '暂无技能，请点击「新建技能」创建' : '没有匹配的技能'}
        </p>
      ) : null}
    </PanelShell>
  )
}
