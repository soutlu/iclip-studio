import { useId } from 'react'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/field'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { captionClock } from './caption-edit'
import type { CatalogVariable, ComponentCatalog } from './composition/catalog'
import { itemNamed, type HostClip } from './composition/film'
import { fieldText, textFields, type LocaleBindings } from './composition/locale-text'
import {
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  translationOf,
  type Language,
  type ShownLocale,
} from './locales'
import { usePausedCommit } from './use-paused-commit'

/** 改片段 `id` 的文字字段 `fieldId` 在语言 `locale` 里的字（见 `useFilmSession` 的 `setItemText`）。 */
export type ItemTextChange = (id: string, fieldId: string, text: string, locale: Language) => void

/** 把片段 `id` 的文字字段 `fieldId` 改成随语言（`follow`）或固定。 */
export type FollowChange = (id: string, fieldId: string, follow: boolean) => void

const NO_BINDINGS: LocaleBindings = {}

const PINNED_NOTE = `固定${SOURCE_NAME}，所有语言共用；点击「随语言」可分别修改`

/** 文字字段右边的「固定 / 随语言」：写着现在是哪种，点一下换成另一种。 */
export function FollowToggle({
  label,
  follows,
  onToggle,
}: {
  label: string
  follows: boolean
  onToggle: (follow: boolean) => void
}) {
  const state = follows ? '随语言' : '固定'
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <button
          aria-label={`${label}：${state}`}
          className={cn('wf-follow ui-state ui-focus', follows && 'is-follow')}
          onClick={() => onToggle(!follows)}
          type="button"
        >
          {state}
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {follows
          ? `各语言分别填写；点击改为固定${SOURCE_NAME}`
          : `所有语言共用${SOURCE_NAME}；点击改为随语言`}
      </TooltipContent>
    </TooltipRoot>
  )
}

type HostTextFieldProps = {
  clip: HostClip
  field: CatalogVariable
  /** 字段随语言时它的根变量；固定时是 undefined。 */
  variable: string | undefined
  /** 显示着的语言；换了语言时调用方要换一个文字框（按语言给 `key`），没写的字留在原来的语言里。 */
  locale: ShownLocale
  onText: ItemTextChange
  className: string
  id?: string
  'aria-label'?: string
}

/**
 * 组件或块的片段的一个文字字段（「组件文字」和「属性」其它语言下共用），停下 300 毫秒再写进去。原文下改的是
 * 原文；其它语言下随语言的字段框里是这种语言的字，还没翻时是空的、占位字提示输入这种语言，下面写着原文；固定的字段只读，
 * 下面说明它所有语言共用。说明排在框和右边的按钮下面（见 `.wf-text-note`）。
 */
export function HostTextField({
  clip,
  field,
  variable,
  locale,
  onText,
  ...input
}: HostTextFieldProps) {
  const { draft, fieldProps } = usePausedCommit((text) =>
    onText(clip.id, field.id, text, locale.code),
  )
  const noteId = useId()
  const source = fieldText(clip.values, field)
  const foreign = locale.values !== null
  const pinned = foreign && variable === undefined
  const shown =
    !foreign || variable === undefined ? source : (translationOf(locale.values, variable) ?? '')
  return (
    <>
      <Input
        {...input}
        {...(pinned ? {} : fieldProps)}
        aria-describedby={foreign ? noteId : undefined}
        autoComplete="off"
        placeholder={
          locale.code !== SOURCE_LOCALE && !pinned
            ? phraseWith('输入', locale.code, '文字…')
            : undefined
        }
        readOnly={pinned}
        value={draft ?? shown}
      />
      {foreign ? (
        <p className="wf-text-note" id={noteId}>
          {pinned ? (
            PINNED_NOTE
          ) : (
            <>
              <span className="wf-caption-source-tag">{SOURCE_NAME}</span> {source}
            </>
          )}
        </p>
      ) : null}
    </>
  )
}

type ComponentTextsProps = {
  /** 有文字字段的组件或块的片段（见 `textHosts`）。 */
  hosts: readonly HostClip[]
  catalog: ComponentCatalog
  bindings: ReadonlyMap<string, LocaleBindings>
  locale: ShownLocale
  /** 工程里加了语言：这时才显示「固定 / 随语言」。 */
  multilingual: boolean
  selected: ReadonlySet<string>
  onText: ItemTextChange
  onFollow: FollowChange
  /** 选中这个片段；`seek` 时播放头也跳到它的开始。 */
  onPick: (clip: HostClip, seek: boolean) => void
}

/**
 * 「字幕」页签的「组件文字」：每个有文字字段的贴片、场景一块（名字、开始时间），每个文字字段一行（名字、文字框，
 * 加了语言时右边是「固定 / 随语言」）。焦点进一块时选中那个片段，点名字还让播放头跳到它的开始。
 */
export function ComponentTexts({
  hosts,
  catalog,
  bindings,
  locale,
  multilingual,
  selected,
  onText,
  onFollow,
  onPick,
}: ComponentTextsProps) {
  if (hosts.length === 0)
    return (
      <p className="wf-captions-note" role="status">
        暂无带文字的贴片或场景，请先在「贴片」「场景」页签中加入
      </p>
    )
  return (
    <ol aria-label="组件文字" className="wf-caption-list">
      {hosts.map((clip) => {
        const item = itemNamed(catalog, clip.item)
        const fields = item === undefined ? [] : textFields(item)
        const bound = bindings.get(clip.id) ?? NO_BINDINGS
        const current = selected.has(clip.id)
        return (
          <li
            aria-current={current ? 'true' : undefined}
            className={cn('wf-caption', current && 'is-current')}
            key={clip.id}
            onFocus={() => {
              if (!current) onPick(clip, false)
            }}
          >
            <button
              className="wf-caption-time wf-text-head"
              onClick={() => onPick(clip, true)}
              type="button"
            >
              <span className="wf-text-name">{clip.label}</span>
              <span>{captionClock(clip.start)}</span>
            </button>
            {fields.map((field) => (
              <TextRow
                bound={bound}
                clip={clip}
                field={field}
                key={field.id}
                locale={locale}
                multilingual={multilingual}
                onFollow={onFollow}
                onText={onText}
              />
            ))}
          </li>
        )
      })}
    </ol>
  )
}

function TextRow({
  clip,
  field,
  bound,
  locale,
  multilingual,
  onText,
  onFollow,
}: {
  clip: HostClip
  field: CatalogVariable
  bound: LocaleBindings
  locale: ShownLocale
  multilingual: boolean
  onText: ItemTextChange
  onFollow: FollowChange
}) {
  const id = useId()
  const variable = bound[field.id]
  return (
    <div className="wf-text-row">
      <label className="wf-prop-label" htmlFor={id} title={field.label}>
        {field.label}
      </label>
      <div className="wf-text-line">
        <HostTextField
          aria-label={`${clip.label} ${field.label}`}
          className="wf-text-input"
          clip={clip}
          field={field}
          id={id}
          key={locale.code}
          locale={locale}
          onText={onText}
          variable={variable}
        />
        {multilingual ? (
          <FollowToggle
            follows={variable !== undefined}
            label={field.label}
            onToggle={(follow) => onFollow(clip.id, field.id, follow)}
          />
        ) : null}
      </div>
    </div>
  )
}
