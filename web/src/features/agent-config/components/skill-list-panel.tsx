import { useId, useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import type { Skill } from '../agents.api'
import { PanelShell } from './panel-shell'
import {
  CARD_SWITCH_HIT,
  CardBadge,
  DIRECTORY_CARD,
  DIRECTORY_GRID,
  DirectoryCardBody,
} from './resource-card'

type SkillListPanelProps = {
  mode: 'library' | 'catalog'
  skills: readonly Skill[]
  boundIds: readonly string[]
  onToggle: (skill: Skill) => void
  onOpen: (skill: Skill) => void
  onCreate: () => void
  onClose: () => void
}

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
  const baseId = useId()
  const keyword = query.trim().toLowerCase()
  const listed = skills.filter(
    (skill) => skill.status === 'active' || (mode === 'catalog' && boundIds.includes(skill.id)),
  )
  const matches = listed.filter((skill) =>
    `${skill.displayName} ${skill.description} ${skill.name}`.toLowerCase().includes(keyword),
  )
  return (
    <PanelShell onClose={onClose} title={mode === 'library' ? '技能库' : '添加技能'}>
      <div className="mb-4 flex items-center gap-2">
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
      <ul className={DIRECTORY_GRID}>
        {matches.map((skill) => {
          const draftOnly = skill.latestVersion === null
          const bound = boundIds.includes(skill.id)
          const opens = mode === 'library' || (draftOnly && !bound)
          const id = `${baseId}-${skill.id}`
          const body = (trailing: ReactNode) => (
            <DirectoryCardBody
              badges={draftOnly ? <CardBadge>草稿</CardBadge> : undefined}
              description={skill.description}
              descriptionId={`${id}-description`}
              icon="skill"
              name={skill.displayName}
              nameId={`${id}-name`}
              trailing={trailing}
            />
          )
          return (
            <li className="flex min-w-0" key={skill.id}>
              {opens ? (
                <button
                  aria-label={`编辑技能：${skill.displayName}`}
                  className={cn(
                    DIRECTORY_CARD,
                    'flex-1 ui-state cursor-pointer bg-background ui-focus',
                  )}
                  onClick={() => onOpen(skill)}
                  type="button"
                >
                  {body(
                    mode === 'library' ? (
                      <Icon
                        className="text-on-surface-faint"
                        decorative
                        name="disclosure"
                        size="sm"
                      />
                    ) : null,
                  )}
                </button>
              ) : (
                <div className={cn(DIRECTORY_CARD, 'flex-1 bg-background')}>
                  {body(
                    <Switch
                      aria-describedby={`${id}-description`}
                      aria-labelledby={`${id}-name`}
                      checked={bound}
                      className={CARD_SWITCH_HIT}
                      onCheckedChange={() => onToggle(skill)}
                    />,
                  )}
                </div>
              )}
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
