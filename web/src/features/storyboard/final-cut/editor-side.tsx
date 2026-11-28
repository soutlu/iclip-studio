import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { TabsContent, TabsRoot } from '@/shared/ui/tabs'
import { audioPlayheadSpot } from './audio'
import { AudioTab } from './audio-tab'
import { captionsFocus } from './caption-edit'
import { CaptionsTab } from './captions-tab'
import type { ComponentCatalog } from './component-catalog'
import type { CaptionClip, FilmClip, VideoClip } from './composition/film'
import { textHosts } from './composition/locale-text'
import type { LocaleControls } from './editor-toolbar'
import { FilmInspector } from './film-inspector'
import { ITEM_KINDS, itemDurationMs, type ItemFilter, type ItemKind } from './items'
import { ItemsTab } from './items-tab'
import type { ShownLocale } from './locales'
import { MaterialArea } from './material-area'
import { NO_PICKS, orderedPicks, picksSummary, usedSpans } from './materials'
import { firstFrameMs } from './selection'
import { SideNav } from './side-nav'
import { usedTabs } from './side-tabs'
import type { useCaptionTools } from './use-caption-tools'
import type { useClipCommands } from './use-clip-commands'
import type { FilmView, useFilmSession } from './use-film-session'
import type { useMaterials } from './use-materials'
import type { usePreviewPlayback } from './use-preview-playback'
import type { useSideSelection } from './use-side-selection'
import type { useSoundControls } from './use-sound-controls'
import type { useTrackPlacement } from './use-track-placement'
import type { useVoiceControl } from './use-voice-control'
import type { useVoicePicking } from './use-voice-picking'

type Inspector = ComponentProps<typeof FilmInspector>

type EditorSideProps = {
  conversationId: string
  film: FilmView
  catalog: ComponentCatalog
  session: ReturnType<typeof useFilmSession>
  clips: readonly FilmClip[]
  captions: readonly CaptionClip[]
  videoClips: readonly VideoClip[]
  locale: ShownLocale
  selection: ReturnType<typeof useSideSelection>
  /** 右栏看不看得见：工作台没折叠、右栏没收起。 */
  sideVisible: boolean
  materials: ReturnType<typeof useMaterials>
  placement: ReturnType<typeof useTrackPlacement>
  player: ReturnType<typeof usePreviewPlayback>
  commands: ReturnType<typeof useClipCommands>
  sound: ReturnType<typeof useSoundControls>
  captionTools: ReturnType<typeof useCaptionTools>
  picking: ReturnType<typeof useVoicePicking>
  voice: ReturnType<typeof useVoiceControl>
  itemFilters: Readonly<Record<ItemKind, ItemFilter>>
  onItemFilters: Dispatch<SetStateAction<Readonly<Record<ItemKind, ItemFilter>>>>
  itemTexts: Inspector['texts']
  localeControls: LocaleControls
  /** 每加 1，「字幕」页签切到「字幕」视图（导出提醒里的「去重配」）。 */
  showCaptions: number
  onCaptionText: Inspector['onCaptionText']
  onGesture: Inspector['onGesture']
  onTextEditing: Inspector['onTextEditing']
  onNotice: (message: string) => void
}

/**
 * final-cut 编辑器的右栏：「镜头」「元素」「模板」「配乐」「字幕」「属性」六个页签。
 * 状态都在编辑器里（见各 `use*` 的说明），这里只摆放。
 */
export function EditorSide({
  conversationId,
  film,
  catalog,
  session,
  clips,
  captions,
  videoClips,
  locale,
  selection,
  sideVisible,
  materials: materialState,
  placement,
  player,
  commands,
  sound,
  captionTools,
  picking,
  voice,
  itemFilters,
  onItemFilters: setItemFilters,
  itemTexts,
  localeControls,
  showCaptions,
  onCaptionText: setCaptionText,
  onGesture: setGesturing,
  onTextEditing: setTextEditing,
  onNotice: notice,
}: EditorSideProps) {
  const {
    selectedClips,
    selected,
    sideTab,
    selectOnly,
    sideRef,
    setSideScroll,
    layout,
    setSideCollapsed,
    openSideTab,
    catalogPanel,
  } = selection
  const {
    materialView,
    materialMs,
    materialPlaying,
    leaveMaterial,
    videos,
    materials,
    sourceNames,
    setPickedVersions,
    takeFilter,
    setTakeFilter,
    closedGroups,
    setClosedGroups,
    versionOf,
    keyframes,
    picks,
    setPicks,
    changePicks,
  } = materialState
  const { setGhost, landingAt, place, placePicks, insert, placeItem, addAtPlayhead, placeAudio } =
    placement
  const { playheadNow, seek } = player
  const { audioPeaks, sourceMs, removeSelected, hideClip, setClipAttributes } = commands
  const { smartMix, silentSource, revealClip, soundControls } = sound
  const {
    captionBlocked,
    addCaption,
    recognizeNote,
    setRecognizeNote,
    recognition,
    captionScripts,
    recognizeBlocked,
    recognize,
    translation,
    pending,
    translateBlockedText,
    translate,
  } = captionTools
  const { shownPick, sideAudition, openVoicePicker, shownDubs, libraryVoices, voicesProblem } =
    picking
  const hostsWithText = textHosts(clips, catalog)

  return (
    <aside
      aria-label="镜头、元素、模板、配乐、字幕和属性"
      className={cn('wf-panel wf-side', layout.sideCollapsed && 'is-collapsed')}
      ref={sideRef}
    >
      <TabsRoot
        className="wf-side-panel"
        onValueChange={openSideTab}
        orientation={layout.sideCollapsed ? 'vertical' : 'horizontal'}
        value={sideTab}
      >
        <SideNav
          collapsed={layout.sideCollapsed}
          onCollapsedChange={setSideCollapsed}
          used={usedTabs(film.clips, catalog)}
        />
        <div className="wf-side-scroll" ref={setSideScroll}>
          <TabsContent className="wf-side-body is-shots" value="shots" {...catalogPanel('shots')}>
            <MaterialArea
              closedGroups={closedGroups}
              filter={takeFilter}
              groups={materials.groups}
              keyframes={keyframes}
              onCarry={(point, carried) =>
                setGhost(
                  point === null
                    ? null
                    : landingAt(point.clientX, point.clientY, picksSummary(carried).durationMs),
                )
              }
              onClear={() => {
                setPicks(NO_PICKS)
                leaveMaterial()
              }}
              onDrop={(point, dropped) => {
                const at = landingAt(point.clientX, point.clientY, picksSummary(dropped).durationMs)
                setGhost(null)
                if (at !== null)
                  placePicks(orderedPicks(materials.groups, dropped), {
                    row: at.row,
                    start: at.start,
                  })
              }}
              onFilter={setTakeFilter}
              onInsert={insert}
              onInsertWhole={(whole) => void place([whole])}
              onPicks={changePicks}
              onToggleGroup={(groupId) =>
                setClosedGroups((current) => {
                  const next = new Set(current)
                  if (!next.delete(groupId)) next.add(groupId)
                  return next
                })
              }
              onVersion={(takeId, jobId) => {
                setPickedVersions((current) => ({ ...current, [takeId]: jobId }))
                const had = picks.get(takeId)
                if (had === undefined) return
                changePicks(takeId, { jobId: had.jobId, spans: [] }, null)
              }}
              placeholder={
                videos.isError ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: () => void videos.refetch() }}
                    message={errorMessageOf(videos.error, '读取素材片失败')}
                  />
                ) : videos.isPending ? (
                  <p className="wf-panel-note" role="status">
                    正在读取素材片…
                  </p>
                ) : undefined
              }
              picks={picks}
              playingMs={materialPlaying ? materialMs : undefined}
              used={usedSpans(videoClips)}
              versionOf={versionOf}
              view={materialView}
            />
          </TabsContent>
          {ITEM_KINDS.map((kind) => (
            <TabsContent
              className="wf-side-body is-items"
              key={kind}
              value={kind}
              {...catalogPanel(kind)}
            >
              <ItemsTab
                catalog={catalog}
                filter={itemFilters[kind]}
                kind={kind}
                onAdd={addAtPlayhead}
                onCarry={(item, point) =>
                  setGhost(
                    point === null
                      ? null
                      : landingAt(point.clientX, point.clientY, itemDurationMs(item, clips)),
                  )
                }
                onDrop={(item, point) => {
                  const at = landingAt(point.clientX, point.clientY, itemDurationMs(item, clips))
                  setGhost(null)
                  if (at !== null) placeItem(item, { row: at.row, start: at.start })
                }}
                onFilterChange={(filter) =>
                  setItemFilters((current) => ({ ...current, [kind]: filter }))
                }
                origin={window.location.origin}
              />
            </TabsContent>
          ))}
          <TabsContent className="wf-side-body is-audio" value="audio" {...catalogPanel('audio')}>
            <AudioTab
              active={sideTab === 'audio' && sideVisible}
              clips={clips}
              conversationId={conversationId}
              onAdd={(audio) =>
                placeAudio(audio, audioPlayheadSpot(clips, playheadNow(), audio.duration))
              }
              onCarry={(audio, point) =>
                setGhost(
                  point === null
                    ? null
                    : landingAt(point.clientX, point.clientY, audio.duration, 'audio'),
                )
              }
              onDrop={(audio, point) => {
                const at = landingAt(point.clientX, point.clientY, audio.duration, 'audio')
                setGhost(null)
                if (at !== null) placeAudio(audio, { row: at.row, start: at.start })
              }}
              onNotice={notice}
              onReveal={revealClip}
            />
          </TabsContent>
          <TabsContent
            className="wf-side-body is-captions"
            value="captions"
            {...catalogPanel('captions')}
          >
            <CaptionsTab
              addBlocked={captionBlocked}
              audition={sideAudition}
              dubs={shownDubs}
              onPickVoice={openVoicePicker}
              onSelect={(caption) => selectOnly(caption.id)}
              picking={shownPick?.pick ?? null}
              showCaptions={showCaptions}
              captions={captions}
              texts={{
                ...itemTexts,
                hosts: hostsWithText,
                catalog,
                onPick: (clip, jump) => {
                  if (jump) seek(firstFrameMs(clip.start))
                  selectOnly(clip.id)
                },
              }}
              locale={locale}
              locales={localeControls}
              focus={captionsFocus(selectedClips, new Set(hostsWithText.map((host) => host.id)))}
              library={{ voices: libraryVoices.data, problem: voicesProblem }}
              onAdd={addCaption}
              onPick={(caption) => {
                seek(firstFrameMs(caption.start))
                selectOnly(caption.id)
              }}
              onRecognize={recognize}
              onRemove={(id) => {
                leaveMaterial()
                session.removeClips([id], false)
              }}
              onText={setCaptionText}
              problem={film.captionsProblem}
              recognizeBlocked={recognizeBlocked}
              recognizeNote={recognizeNote}
              onRecognizeNoteClose={() => setRecognizeNote(undefined)}
              recognizing={recognition.recognizing}
              scripts={captionScripts}
              selected={selected}
              voice={voice}
              translate={
                pending === undefined
                  ? undefined
                  : {
                      blocked: translateBlockedText,
                      translating: translation.translating,
                      onTranslate: () => void translate(),
                    }
              }
            />
          </TabsContent>
          <TabsContent
            className="wf-side-body is-props"
            hidden={sideTab !== 'props' || layout.sideCollapsed}
            value="props"
          >
            <FilmInspector
              audioPeaks={audioPeaks}
              clips={clips}
              catalog={catalog}
              canvas={film.canvas}
              keyframes={keyframes}
              onGesture={setGesturing}
              onHide={hideClip}
              onRemove={removeSelected}
              onRetime={(timings) => {
                leaveMaterial()
                session.retime(timings)
              }}
              onTextEditing={setTextEditing}
              onValues={(id, values) => {
                leaveMaterial()
                session.setValues(id, values)
              }}
              onAttributes={setClipAttributes}
              locale={locale}
              onCaptionText={setCaptionText}
              captionStyle={film.captionStyle}
              onCaptionStyle={(id, changes) => {
                leaveMaterial()
                session.setCaptionStyle(id, changes)
              }}
              onCaptionTrackStyle={(changes) => {
                leaveMaterial()
                session.setCaptionTrackStyle(changes)
              }}
              onCaptionOwnStyle={(id, own) => {
                leaveMaterial()
                session.setCaptionOwnStyle(id, own)
              }}
              texts={itemTexts}
              selected={selectedClips}
              silentSource={silentSource}
              soundControls={soundControls}
              sourceMs={sourceMs}
              sourceName={(src) => sourceNames.get(src)}
              smartMix={smartMix}
              onOpenCaptions={() => openSideTab('captions')}
              voice={voice}
              voices={libraryVoices.data}
              onPickVoice={(caption, trigger) =>
                openVoicePicker({ target: 'line', caption }, trigger)
              }
            />
          </TabsContent>
        </div>
      </TabsRoot>
    </aside>
  )
}
