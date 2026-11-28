import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { InlineAlert } from '@/shared/ui/inline-alert'
import type { UndoHistory } from '../editing/undo-shortcut'
import { SPLIT_REFUSAL_TEXT, type Links } from './clip-edit'
import type { ComponentCatalog } from './component-catalog'
import type { CaptionClip, FilmClip } from './composition/film'
import type { dubLooksOf } from './dub-look'
import { EditorToolbar, type EditTool, type LocaleControls } from './editor-toolbar'
import { FilmTimeline } from './film-timeline'
import { hostTextIn } from './host-text'
import { captionIn, type ShownLocale } from './locales'
import { onRow } from './placement'
import { rowMoveDirection } from './stacking'
import type { useClipCommands } from './use-clip-commands'
import type { FilmView, useFilmSession } from './use-film-session'
import type { useMaterials } from './use-materials'
import type { usePreviewPlayback } from './use-preview-playback'
import type { useSideSelection } from './use-side-selection'
import type { useSoundControls } from './use-sound-controls'
import type { useTimelineZoom } from './use-timeline-zoom'
import type { useTrackPlacement } from './use-track-placement'
import { withVolumePoints } from './volume-envelope'

type EditorTimelinePanelProps = {
  film: FilmView
  catalog: ComponentCatalog
  session: ReturnType<typeof useFilmSession>
  clips: readonly FilmClip[]
  captions: readonly CaptionClip[]
  locale: ShownLocale
  links: Links
  selection: ReturnType<typeof useSideSelection>
  materials: ReturnType<typeof useMaterials>
  player: ReturnType<typeof usePreviewPlayback>
  zoom: ReturnType<typeof useTimelineZoom>
  commands: ReturnType<typeof useClipCommands>
  sound: ReturnType<typeof useSoundControls>
  placement: ReturnType<typeof useTrackPlacement>
  history: UndoHistory
  tool: EditTool
  onTool: Dispatch<SetStateAction<EditTool>>
  gesturing: boolean
  onGesture: (active: boolean) => void
  localeControls: LocaleControls
  dubLooks: ReturnType<typeof dubLooksOf>
  /** 时间线上还没有配音行时写在配音行位置的去哪里配，不写时是 null。 */
  dubHint: string | null
}

/**
 * final-cut 编辑器的时间线面板：工具条、时间线和保存失败时的「重新保存」。
 * 状态都在编辑器里（见各 `use*` 的说明），这里只摆放。
 */
export function EditorTimelinePanel({
  film,
  catalog,
  session,
  clips,
  captions,
  locale,
  links,
  selection,
  materials,
  player,
  zoom: timelineZoom,
  commands,
  sound,
  placement,
  history,
  tool,
  onTool: setTool,
  gesturing,
  onGesture: setGesturing,
  localeControls,
  dubLooks,
  dubHint,
}: EditorTimelinePanelProps) {
  const { selected, timelinePanelRef } = selection
  const { leaveMaterial } = materials
  const { clock, buffered, total, playhead, seek, jumpInto } = player
  const { setViewportWidth, zoom, scale, timelineRef, scrollRequest, zoomTo, zoomToSelection } =
    timelineZoom
  const {
    selectOnTimeline,
    selectAround,
    inspectClip,
    split,
    playheadCut,
    splitAtPlayhead,
    sourceMs,
    ripple,
    setRipple,
    removeSelected,
    hideClip,
    setClipAttributes,
  } = commands
  const { musicBeats, silentSource, soundControls, soundAction } = sound
  const { ghost, snap, setSnap, trackFor } = placement
  // 时间线上写「待输入字幕」的字幕：显示着的语言下没字的（没翻的、空着的）
  const blankCaptions = useMemo(
    () =>
      new Set(
        captions
          .filter((caption) => captionIn(locale, caption).text.trim() === '')
          .map((c) => c.id),
      ),
    [captions, locale],
  )
  // 元素、模板片段上接在名字后面的文字：显示着的语言下的
  const hostBindings = film.bindings
  const hostTexts = useMemo(
    () =>
      new Map(
        clips.flatMap((clip) => {
          if (clip.kind !== 'host') return []
          const text = hostTextIn(locale, clip, catalog, hostBindings.get(clip.id) ?? {})
          return text === null ? [] : [[clip.id, text] as const]
        }),
      ),
    [clips, locale, catalog, hostBindings],
  )

  return (
    <div className="wf-panel wf-timeline" ref={timelinePanelRef}>
      <EditorToolbar
        canRedo={history.canRedo}
        canUndo={history.canUndo}
        fitPps={scale.fitPps}
        onRedo={() => {
          leaveMaterial()
          session.redo()
        }}
        onUndo={() => {
          leaveMaterial()
          session.undo()
        }}
        hasSelection={selected.size > 0}
        onRemove={removeSelected}
        sound={{
          kind: soundAction.kind === 'merge' ? 'merge' : 'detach',
          blocked: soundAction.blocked,
          onClick: () => soundControls.run(soundAction),
        }}
        onSelectAround={selectAround}
        onSplit={splitAtPlayhead}
        onTool={setTool}
        splitBlocked={
          'refusal' in playheadCut ? SPLIT_REFUSAL_TEXT[playheadCut.refusal] : undefined
        }
        tool={tool}
        locales={localeControls}
        onZoomToSelection={zoomToSelection}
        onRipple={() => setRipple((on) => !on)}
        onSnap={() => setSnap((on) => !on)}
        onZoom={zoomTo}
        ripple={ripple}
        snap={snap}
        zoom={zoom}
      />
      <FilmTimeline
        clips={clips}
        blankCaptions={blankCaptions}
        dubLooks={dubLooks}
        dubHint={dubHint}
        dubbing={film?.voiceMode === 'dub'}
        hostTexts={hostTexts}
        links={links}
        onSplit={split}
        tool={tool}
        buffered={buffered}
        catalog={catalog}
        ghost={ghost}
        gesturing={gesturing}
        handleRef={timelineRef}
        onAttributes={setClipAttributes}
        onHideClip={hideClip}
        onRemove={removeSelected}
        silentSource={silentSource}
        soundControls={soundControls}
        onHide={(row, hidden) => {
          leaveMaterial()
          session.setHidden(
            clips.filter((clip) => onRow(clip, row)).map((clip) => clip.id),
            hidden,
          )
        }}
        onRetime={(timings) => {
          leaveMaterial()
          session.retime(timings)
        }}
        onGesture={setGesturing}
        onInspect={inspectClip}
        onJump={jumpInto}
        onSeek={seek}
        onSelect={selectOnTimeline}
        onViewportWidth={setViewportWidth}
        playheadMs={playhead}
        clock={clock}
        scale={scale}
        onMove={(id, row, start, starts) => {
          const { track, renumber } = trackFor(row, id)
          leaveMaterial()
          session.moveClip(id, { track, start }, rowMoveDirection(clips, id, row), renumber, starts)
        }}
        onRestart={(starts) => {
          leaveMaterial()
          session.restart(starts)
        }}
        onEnvelope={(id, points) => {
          leaveMaterial()
          session.setAutomation(id, (automation) => withVolumePoints(automation, points))
        }}
        scrollRequest={scrollRequest}
        selected={selected}
        snap={snap}
        beats={musicBeats}
        sourceMs={sourceMs}
        totalMs={total}
      />
      {session.save.kind === 'failed' ? (
        <InlineAlert
          action={{ label: '重新保存', onClick: session.flush }}
          message={session.save.message}
        />
      ) : null}
    </div>
  )
}
