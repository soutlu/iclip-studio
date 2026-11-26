import { useId, type ReactNode } from 'react'
import { AUDIO_FILTER_VALUES, type AudioFilterKey } from '@/shared/api/reference-audios'
import { cn } from '@/shared/lib/utils'
import { AUDIO_FILTER_LABELS, audioFilterOptions } from '@/shared/ui/audition'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Input, Textarea } from '@/shared/ui/field'
import {
  BPM_MAX,
  BPM_MIN,
  bpmOf,
  MAX_SCENARIOS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  type AudioFormValues,
} from '../audio-form'

type FieldsProps = {
  values: AudioFormValues
  onChange: (patch: Partial<AudioFormValues>) => void
}

/** 字段上方的小标签，右边可带一句灰字。 */
function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string
  hint?: string | undefined
  htmlFor?: string
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label className="text-body-sm text-on-surface-variant" htmlFor={htmlFor}>
          {label}
        </label>
        {hint === undefined ? null : (
          <span className="text-caption text-on-surface-faint">{hint}</span>
        )}
      </div>
      {children}
    </div>
  )
}

/** 名称、一句话描述，一条细线，再按子类填属性。添加和修改共用。 */
export function AudioDetailsFields({ values, onChange }: FieldsProps) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <>
      <Field htmlFor={titleId} label="名称">
        <Input
          id={titleId}
          maxLength={MAX_TITLE_CHARS}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="输入名称"
          value={values.title}
        />
      </Field>
      <Field htmlFor={descriptionId} label="一句话风格描述">
        <Input
          id={descriptionId}
          maxLength={MAX_TEXT_CHARS}
          onChange={(event) => onChange({ description: event.target.value })}
          placeholder="说明风格与适用场合（选填）"
          value={values.description}
        />
      </Field>
      <hr className="border-hairline" />
      {values.kind === 'voice' ? (
        <VoiceTraits onChange={onChange} values={values} />
      ) : values.kind === 'bgm' ? (
        <BgmTraits onChange={onChange} values={values} />
      ) : (
        <SinglePick
          field="sfxCategory"
          label="音效分类"
          onPick={(id) =>
            onChange({
              sfxCategory: AUDIO_FILTER_VALUES.sfxCategory.find((each) => each === id) ?? null,
            })
          }
          value={values.sfxCategory}
        />
      )}
    </>
  )
}

function VoiceTraits({ values, onChange }: FieldsProps) {
  const transcriptId = useId()
  return (
    <>
      <SinglePick
        field="locale"
        label="语种"
        onPick={(id) => {
          // 语种总有一个选中：不设语种就是「多语种」，再点不取消
          const picked = AUDIO_FILTER_VALUES.locale.find((each) => each === id)
          if (picked !== undefined) onChange({ locale: picked === 'none' ? null : picked })
        }}
        value={values.locale ?? 'none'}
      />
      <div className="grid grid-cols-2 gap-4">
        <SinglePick
          field="gender"
          onPick={(id) =>
            onChange({ gender: AUDIO_FILTER_VALUES.gender.find((each) => each === id) ?? null })
          }
          segmented
          value={values.gender}
        />
        <SinglePick
          field="age"
          onPick={(id) =>
            onChange({ age: AUDIO_FILTER_VALUES.age.find((each) => each === id) ?? null })
          }
          segmented
          value={values.age}
        />
      </div>
      <Field hint={`最多选择 ${String(MAX_SCENARIOS)} 项`} label="适用场景">
        <ChipGroup
          aria-label="适用场景"
          onValueChange={(next) => {
            // 新选的排在最后；选第三个时把最早选的那个换掉
            const picked = next.flatMap((id) =>
              AUDIO_FILTER_VALUES.scenario.filter((each) => each === id),
            )
            onChange({ scenarios: picked.slice(-MAX_SCENARIOS) })
          }}
          type="multiple"
          value={[...values.scenarios]}
          variant="option"
        >
          {audioFilterOptions('scenario').map((option) => (
            <FilterChip key={option.id} value={option.id} variant="option">
              {option.label}
            </FilterChip>
          ))}
        </ChipGroup>
      </Field>
      <Field htmlFor={transcriptId} label="参考台词（选填）">
        <Textarea
          className="resize-y"
          id={transcriptId}
          maxLength={MAX_TEXT_CHARS}
          onChange={(event) => onChange({ transcript: event.target.value })}
          placeholder="该音色音频中的台词文本"
          rows={3}
          value={values.transcript}
        />
      </Field>
    </>
  )
}

function BgmTraits({ values, onChange }: FieldsProps) {
  const bpmId = useId()
  const invalid = bpmOf(values.bpm) === undefined
  return (
    <>
      <SinglePick
        field="mood"
        onPick={(id) =>
          onChange({ mood: AUDIO_FILTER_VALUES.mood.find((each) => each === id) ?? null })
        }
        value={values.mood}
      />
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <SinglePick
          className="min-w-0 flex-1"
          field="genre"
          onPick={(id) =>
            onChange({ genre: AUDIO_FILTER_VALUES.genre.find((each) => each === id) ?? null })
          }
          value={values.genre}
        />
        <Field
          className="w-32"
          hint={invalid ? `${String(BPM_MIN)}～${String(BPM_MAX)}` : undefined}
          htmlFor={bpmId}
          label="节奏（选填）"
        >
          <div className="relative">
            <Input
              aria-invalid={invalid}
              className="h-(--control-height-lg) pr-12 tabular-nums"
              id={bpmId}
              inputMode="numeric"
              max={BPM_MAX}
              min={BPM_MIN}
              onChange={(event) => onChange({ bpm: event.target.value })}
              step={1}
              type="number"
              value={values.bpm}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3.5 grid place-items-center text-caption text-on-surface-faint">
              BPM
            </span>
          </div>
        </Field>
      </div>
    </>
  )
}

/**
 * 一项属性的单选：选项小块，或 `segmented` 分段（性别、年龄）。再点一下选中的会把空串交给 `onPick`，
 * 选填的项借此取消。
 */
function SinglePick({
  field,
  label = AUDIO_FILTER_LABELS[field].name,
  value,
  onPick,
  segmented = false,
  className,
}: {
  field: AudioFilterKey
  label?: string
  value: string | null
  onPick: (id: string) => void
  segmented?: boolean
  className?: string
}) {
  const variant = segmented ? 'segmented' : 'option'
  return (
    <Field className={className} label={label}>
      <ChipGroup
        aria-label={label}
        className={cn(segmented && 'h-(--control-height-lg)')}
        onValueChange={onPick}
        type="single"
        value={value ?? ''}
        variant={variant}
      >
        {audioFilterOptions(field).map((option) => (
          <FilterChip key={option.id} value={option.id} variant={variant}>
            {option.label}
          </FilterChip>
        ))}
      </ChipGroup>
    </Field>
  )
}
