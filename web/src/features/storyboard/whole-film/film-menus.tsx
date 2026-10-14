/** 整片编辑器底部的几个菜单，一律向上展开：控制条上的「添加」（选成片放进素材区）、素材区为空时那一行「添加视频」、
 * 素材轨轨道头上的版本胶囊。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import {
  MenuBareItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSub,
  MenuSubSurface,
  MenuSubTrigger,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import type { Material, MaterialCatalog, MaterialDuration } from './film-materials'

const seconds = (value: number) => `${value.toFixed(1)} 秒`

/** 一版的小画面：截不了帧（不是 OSS 地址、截失败）时露出中性底与视频图标。 */
function Poster({ url, className }: { url: string; className: string }) {
  const src = videoSnapshotUrl(url, 96)
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
                    aria-label={`${group.label} ${material.version}${duration == null ? '' : `，${seconds(duration)}`}`}
                    className="film-menu-tile"
                    key={material.jobId}
                    onSelect={() => onAdd(material)}
                  >
                    <span className="film-menu-tile-picture">
                      <Poster className="film-menu-tile-poster" url={material.url} />
                      <span className="film-menu-tile-version">{material.version}</span>
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
      <p className="film-menu-foot">
        <Icon decorative name="info" size="xs" />
        <span>选一条成片，添加为一条素材轨；同一镜头组只有一条素材轨，换版本在轨道头切换</span>
      </p>
    </>
  )
}

/** 控制条上的「添加」：现在只有「视频」一项，向右展开选成片的面板。 */
export function AddMenu(props: PanelProps) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button className="video-editor-bar-button film-add-button ui-state ui-focus" type="button">
          <Icon decorative name="add" size="md" />
          <span className="video-editor-tool-label">添加</span>
          <Icon className="film-add-caret" decorative name="expand" size="xs" />
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="film-menu-small" side="top">
        <MenuSub>
          <MenuSubTrigger icon="video">视频</MenuSubTrigger>
          <MenuSubSurface alignOffset={-5} className="film-menu-panel">
            <TakesPanel {...props} />
          </MenuSubSurface>
        </MenuSub>
      </MenuSurface>
    </MenuRoot>
  )
}

/** 素材区为空时的那一行：「添加视频」直接展开选成片的面板。 */
export function AddVideoRow(props: PanelProps) {
  return (
    <div className="film-materials-empty">
      <MenuRoot>
        <MenuTrigger asChild>
          <button className="film-materials-add ui-state ui-focus" type="button">
            <Icon decorative name="add" size="xs" />
            添加视频
          </button>
        </MenuTrigger>
        <MenuSurface align="start" className="film-menu-panel" side="top">
          <TakesPanel {...props} />
        </MenuSurface>
      </MenuRoot>
      <span>选一条本对话的成片，作为一条素材轨</span>
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

/** 素材轨轨道头上的版本胶囊：当前用的那一版，点开向上列出这一组的各版，换了只影响之后挑的段。 */
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
