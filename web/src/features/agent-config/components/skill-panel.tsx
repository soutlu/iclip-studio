import type { Skill } from '../agents.api'
import type { SkillView } from './panel'
import { SkillCreateForm } from './skill-create-form'
import { SkillEditor } from './skill-editor'
import { SkillListPanel } from './skill-list-panel'

type SkillPanelProps = {
  view: SkillView
  skills: readonly Skill[]
  skillIds: readonly string[]
  onSkillIdsChange: (skillIds: string[]) => void
  onNavigate: (view: SkillView) => void
  onClose: () => void
}

export function SkillPanel({
  onClose,
  onNavigate,
  onSkillIdsChange,
  skillIds,
  skills,
  view,
}: SkillPanelProps) {
  const back = (to: 'library' | 'catalog' | null) =>
    to === null ? onClose() : onNavigate({ kind: to })

  switch (view.kind) {
    case 'library':
    case 'catalog':
      return (
        <SkillListPanel
          boundIds={skillIds}
          key={view.kind}
          mode={view.kind}
          onClose={onClose}
          onCreate={() => onNavigate({ back: view.kind, kind: 'new' })}
          onOpen={(skill) => onNavigate({ back: view.kind, kind: 'editor', skillId: skill.id })}
          onToggle={(skill) =>
            onSkillIdsChange(
              skillIds.includes(skill.id)
                ? skillIds.filter((id) => id !== skill.id)
                : [...skillIds, skill.id],
            )
          }
          skills={skills}
        />
      )
    case 'new':
      return (
        <SkillCreateForm
          key="new"
          onBack={() => back(view.back)}
          onCreated={(skillId) => onNavigate({ back: view.back, kind: 'editor', skillId })}
        />
      )
    case 'editor':
      return (
        <SkillEditor
          key={view.skillId}
          onBack={() => back(view.back)}
          onRemove={
            skillIds.includes(view.skillId)
              ? () => {
                  onSkillIdsChange(skillIds.filter((id) => id !== view.skillId))
                  onNavigate({ kind: 'catalog' })
                }
              : undefined
          }
          skillId={view.skillId}
        />
      )
  }
}
