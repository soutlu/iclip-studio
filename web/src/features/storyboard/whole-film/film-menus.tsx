/** 整片编辑器的菜单：轨道两端选择片头片尾，素材区末尾的加号选镜头组，轨道头上的版本胶囊换版本。 */

import { useState, type CSSProperties } from 'react'
import type { BrandTemplate } from '@/shared/api/brand-templates'
import type { BrandPosition, FilmBrand } from './film-draft'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import {
  MenuBareItem,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import type { Material, MaterialCatalog, MaterialDuration } from './film-materials'

import { videoTemplateReason } from './film-brand'

const seconds = (value: number) => `${value.toFixed(1)} 秒`

/** 一版的小画面：截不了帧（不是 OSS 地址、截失败）时露出中性底与视频图标。 */
function Poster({
  url,
  className,
  atSeconds = 0,
}: {
  url: string
  className: string
  atSeconds?: number
}) {
  const src = videoSnapshotUrl(url, 96, atSeconds)
  const [failed, setFailed] = useState(false)
  return (
    <span className={cn('film-poster', className)}>
      {src === undefined || failed ? (
        <Icon decorative name="video" size="sm" />
      ) : (
        <img alt="" draggable={false} onError={() => setFailed(true)} src={src} />
      )}
    </span>
  )
}

type PanelProps = {
  catalog: MaterialCatalog
  /** 一版多长；没读到或读不出时格子下面不写时长。 */
  durationOf: (material: Material) => MaterialDuration
  onAdd: (material: Material) => void
}

/** 选成片的面板：按组一行，列出各版小画面与时长；点一格放进素材区。 */
function TakesPanel({ catalog, durationOf, onAdd }: PanelProps) {
  if (catalog.groups.length === 0)
    return <p className="film-menu-empty">本对话还没有成片，请先在镜头组中生成视频</p>
  return (
    <>
      <p className="film-menu-head">本对话的成片 · {catalog.groups.length} 组</p>
      <div className="film-menu-rows">
        {catalog.groups.map((group) => (
          <div className="film-menu-row" key={group.id}>
            <p className="film-menu-row-label">
              <strong>{group.label}</strong>
              <span>{group.versions.length} 个成片</span>
            </p>
            <div className="film-menu-tiles">
              {group.versions.toReversed().map((material) => {
                const duration = durationOf(material)
                return (
                  <MenuBareItem
                    aria-label={`${group.label} ${material.takeLabel} ${material.version}${duration == null ? '' : `，${seconds(duration)}`}`}
                    className="film-menu-tile"
                    key={material.jobId}
                    onSelect={() => onAdd(material)}
                  >
                    <span className="film-menu-tile-picture">
                      <Poster className="film-menu-tile-poster" url={material.url} />
                      <span className="film-menu-tile-version">
                        {material.takeLabel} · {material.version}
                      </span>
                    </span>
                    <span className="film-menu-tile-duration">
                      {duration == null ? '' : seconds(duration)}
                    </span>
                  </MenuBareItem>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/** 空模板只占固定像素，不进入视频时钟。 */
export function BrandPlaceholder({
  brands,
  position,
  style,
}: {
  brands: BrandMenuProps
  position: BrandPosition
  style: CSSProperties
}) {
  const label = position === 'intro' ? '片头' : '片尾'
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label={`添加${label}`}
          className="film-brand-placeholder ui-state ui-focus"
          style={style}
          type="button"
        >
          <span className="film-brand-placeholder-picture">
            <Icon decorative name="video" size="sm" />
          </span>
          <span>
            <Icon decorative name="add" size="xs" />
            {label}
          </span>
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="film-menu-panel" side="top">
        <TemplatePanel brands={brands} position={position} />
      </MenuSurface>
    </MenuRoot>
  )
}

/** 素材区末尾常驻的加号：直接展开本对话镜头组的成片版本。 */
export function AddVideoRow({ disabled = false, ...props }: PanelProps & { disabled?: boolean }) {
  return (
    <div className="film-materials-add-row">
      <MenuRoot>
        <MenuTrigger asChild disabled={disabled}>
          <button className="film-materials-add ui-state ui-focus" type="button">
            <Icon decorative name="add" size="xs" />
            添加镜头组
          </button>
        </MenuTrigger>
        <MenuSurface align="start" className="film-menu-panel" side="top">
          <TakesPanel {...props} />
        </MenuSurface>
      </MenuRoot>
    </div>
  )
}

type VersionPillProps = {
  groupLabel: string
  versions: readonly Material[]
  current: Material
  durationOf: (material: Material) => MaterialDuration
  onSwitch: (material: Material) => void
}

export function VersionPill({
  groupLabel,
  versions,
  current,
  durationOf,
  onSwitch,
}: VersionPillProps) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label={`${groupLabel} 当前用 ${current.version}，换版本`}
          className="film-version-pill ui-state ui-focus"
          type="button"
        >
          {current.version}
          <Icon decorative name="expand" size="xs" />
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="film-menu-versions" side="top">
        <p className="film-menu-head">{groupLabel} 的成片</p>
        <MenuRadioGroup
          onValueChange={(jobId) => {
            const next = versions.find((item) => item.jobId === jobId)
            if (next !== undefined) onSwitch(next)
          }}
          value={current.jobId}
        >
          {versions.toReversed().map((material) => {
            const duration = durationOf(material)
            return (
              <MenuRadioItem
                className="film-menu-version"
                key={material.jobId}
                value={material.jobId}
              >
                <span className="film-menu-version-body">
                  <Poster className="film-menu-version-poster" url={material.url} />
                  <strong>{material.version}</strong>
                  {duration == null ? null : <span>{seconds(duration)}</span>}
                </span>
              </MenuRadioItem>
            )
          })}
        </MenuRadioGroup>
        <p className="film-menu-foot">
          <Icon decorative name="info" size="xs" />
          <span>只影响之后挑的段</span>
        </p>
      </MenuSurface>
    </MenuRoot>
  )
}

export type BrandMenuProps = {
  templates: readonly BrandTemplate[]
  reason: string | undefined
  retry?: (() => void) | undefined
  intro: FilmBrand | null | undefined
  outro: FilmBrand | null | undefined
  onSelect: (position: BrandPosition, template: BrandTemplate) => void
  onRemove: (position: BrandPosition) => void
}

function TemplatePanel({ brands, position }: { brands: BrandMenuProps; position: BrandPosition }) {
  const label = position === 'intro' ? '片头' : '片尾'
  const selected = brands[position]
  const candidates = brands.templates.filter((template) => template.kind === position)
  return (
    <>
      <p className="film-menu-head">{label}模板</p>
      {brands.reason !== undefined ? (
        <p className="film-menu-empty">{brands.reason}</p>
      ) : candidates.length === 0 ? (
        <p className="film-menu-empty">暂无与正文画幅相近的{label}模板</p>
      ) : (
        candidates.map((template) => {
          const reason = videoTemplateReason(template)
          return (
            <MenuBareItem
              aria-label={`${template.name}${reason === undefined && template.durationMs !== null ? `，${seconds(template.durationMs / 1000)}` : `，${reason}`}`}
              disabled={reason !== undefined}
              className="film-template-option"
              key={template.id}
              onSelect={() => brands.onSelect(position, template)}
            >
              {/* 片头片尾的首帧常是淡入底色，封面取 Logo 已出现的画面。 */}
              <Poster className="film-template-poster" url={template.url} atSeconds={0.5} />
              <span>
                <strong>{template.name}</strong>
                <span>
                  {reason ??
                    (template.durationMs === null
                      ? undefined
                      : seconds(template.durationMs / 1000))}
                </span>
              </span>
              {selected?.templateId === template.id ? (
                <Icon decorative name="check" size="sm" />
              ) : null}
            </MenuBareItem>
          )
        })
      )}
      {brands.retry === undefined ? null : (
        <MenuItem onSelect={brands.retry}>重试读取模板</MenuItem>
      )}
      {selected == null ? null : (
        <MenuItem destructive icon="delete" onSelect={() => brands.onRemove(position)}>
          删除{label}
        </MenuItem>
      )}
      <p className="film-menu-foot">位置固定，选择另一模板即可替换；模板由管理员在资料库维护</p>
    </>
  )
}

/** 已选模板卡上的更换入口，与空位共用候选与校验。 */
export function BrandMenu({
  brands,
  position,
}: {
  brands: BrandMenuProps
  position: BrandPosition
}) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button className="editor-bar-button ui-state ui-focus" type="button">
          更换模板
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="film-menu-panel">
        <TemplatePanel brands={brands} position={position} />
      </MenuSurface>
    </MenuRoot>
  )
}
