import type { ComponentProps, RefObject } from 'react'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { CanvasOverlay, type CanvasNudge } from './canvas-overlay'
import { CanvasSettings, FramingGuides } from './canvas-settings'
import type { ComponentCatalog } from './component-catalog'
import type { FilmClip, VideoClip } from './composition/film'
import type { exportTierOf, useChosenTier } from './export-tier'
import type { ShownLocale } from './locales'
import { takeDurationMs } from './material-media'
import { MaterialPreview } from './material-preview'
import { PreviewPlayer, type PreviewControl } from './preview-player'
import { PreviewTransport } from './preview-transport'
import type { FilmView, useFilmSession } from './use-film-session'
import type { useMaterials } from './use-materials'
import type { usePreviewPlayback } from './use-preview-playback'
import type { useStageFullscreen } from './use-stage-fullscreen'
import type { useStagePreview } from './use-stage-preview'

type Overlay = ComponentProps<typeof CanvasOverlay>

type EditorStageProps = {
  film: FilmView
  catalog: ComponentCatalog
  clips: readonly FilmClip[]
  videoClips: readonly VideoClip[]
  locale: ShownLocale
  session: ReturnType<typeof useFilmSession>
  /** 编辑器根节点：不全屏时「画面设置」浮层挂进它。 */
  root: HTMLElement | null
  previewRef: RefObject<PreviewControl | null>
  player: ReturnType<typeof usePreviewPlayback>
  materials: ReturnType<typeof useMaterials>
  screen: ReturnType<typeof useStageFullscreen>
  preview: ReturnType<typeof useStagePreview>
  /** 预览放不了时的原因（工程里还没有内容），播放条同样按它禁用播放。 */
  playBlocked: string | undefined
  canvasNudgeRef: RefObject<CanvasNudge | null>
  selected: ReadonlySet<string>
  exportTier: ReturnType<typeof exportTierOf>
  onTier: ReturnType<typeof useChosenTier>[1]
  onCaptionText: Overlay['onCaptionText']
  onGesture: Overlay['onGesture']
  onNotice: (message: string) => void
  onSelect: Overlay['onSelect']
  onText: Overlay['onText']
}

/**
 * final-cut 编辑器的舞台：预览（上面盖着画面编辑层和参考线）或素材预览、「画面设置」浮层和播放条。
 * 状态都在编辑器里（见各 `use*` 的说明），这里只摆放。
 */
export function EditorStage({
  film,
  catalog,
  clips,
  videoClips,
  locale,
  session,
  root,
  previewRef,
  player,
  materials,
  screen,
  preview,
  playBlocked,
  canvasNudgeRef,
  selected,
  exportTier,
  onTier: chooseTier,
  onCaptionText: setCaptionText,
  onGesture: setGesturing,
  onNotice: notice,
  onSelect: setSelectedIds,
  onText,
}: EditorStageProps) {
  const {
    clock,
    playing,
    followPreviewTime,
    followPlaying,
    buffering,
    setBuffering,
    buffered,
    setBuffered,
    playback,
    setPlayback,
    toggleMute,
    toggleLoop,
    total,
    frameMs,
    seek,
    togglePlay,
  } = player
  const {
    materialView,
    materialClock,
    followMaterial,
    materialPlaying,
    setMaterialPlaying,
    materialPreviewRef,
    leaveMaterial,
    keyframes,
    viewedMaterial,
    materialLabel,
  } = materials
  const { stage, setStage, fullscreen, fullscreenBlocked, toggleFullscreen } = screen
  const {
    framing,
    setFraming,
    previewPage,
    previewFilm,
    layerTable,
    watchedLayers,
    setWatchedLayers,
    layerMeasures,
    setLayerMeasures,
    textTarget,
    setTextTarget,
  } = preview
  // 垫在预览后面的那一帧取最上面显示着的片段：文件里写在后面的在上面
  const shown = videoClips.findLast(
    (clip) => !clip.hidden && clip.start <= frameMs && frameMs < clip.start + clip.duration,
  )
  // 素材预览显示着时播放条换成素材的：时间和进度按整条原作算（还没读到时长先用选中范围的结尾），
  // 拖进度条在素材里跳
  const transportSource =
    materialView === null
      ? { clock, totalMs: total, buffered, playBlocked, playing, onSeek: seek }
      : {
          clock: materialClock,
          totalMs:
            takeDurationMs(
              viewedMaterial === undefined ? undefined : keyframes.get(viewedMaterial.url),
            ) ?? materialView.span.endMs,
          buffered: [],
          playBlocked: undefined,
          playing: materialPlaying,
          onSeek: (ms: number) => materialPreviewRef.current?.seek(ms),
        }

  const canvasOverlay =
    materialView !== null ? null : (
      <>
        <FramingGuides canvas={film.canvas} framing={framing} />
        <CanvasOverlay
          bindings={film.bindings}
          canvas={film.canvas}
          catalog={catalog}
          clips={clips}
          contentOf={session.contentOf}
          controlRef={previewRef}
          frameMs={frameMs}
          layers={film.layers}
          locale={locale}
          measures={layerMeasures}
          nudgeRef={canvasNudgeRef}
          onCaptionText={setCaptionText}
          onEdit={(edits) => {
            leaveMaterial()
            session.editLayers(edits)
          }}
          onGesture={setGesturing}
          onNotice={notice}
          onSelect={setSelectedIds}
          onText={onText}
          onTextClose={() => setTextTarget(null)}
          onWatch={setWatchedLayers}
          playing={playing}
          revision={film.revision}
          selected={selected}
          textTarget={textTarget}
        />
      </>
    )

  return (
    <div className="wf-stage" ref={setStage}>
      <PreviewPlayer
        backdrop={shown === undefined ? undefined : videoSnapshotUrl(shown.src, 320)}
        controlRef={previewRef}
        film={previewFilm}
        height={film.canvas.height}
        layers={layerTable}
        message={playBlocked}
        onBuffered={setBuffered}
        onBuffering={setBuffering}
        onMeasured={setLayerMeasures}
        onPlaying={followPlaying}
        onTextTarget={setTextTarget}
        onTime={followPreviewTime}
        overlay={canvasOverlay}
        page={previewPage}
        playback={playback}
        watch={watchedLayers}
        width={film.canvas.width}
      >
        {buffering ? <MediaBuffering /> : null}
      </PreviewPlayer>
      {materialView === null ? (
        <CanvasSettings
          background={film.background}
          canvas={film.canvas}
          framing={framing}
          layer={fullscreen ? stage : root}
          onBackground={session.setBackground}
          onCanvas={session.resize}
          onFraming={setFraming}
          onTier={chooseTier}
          tier={exportTier.tier}
        />
      ) : null}
      {viewedMaterial === undefined || materialView === null ? null : (
        <MaterialPreview
          controlRef={materialPreviewRef}
          label={materialLabel(viewedMaterial, materialView.span)}
          muted={playback.muted}
          layer={fullscreen ? stage : null}
          onLeave={leaveMaterial}
          onNotice={notice}
          onPlaying={setMaterialPlaying}
          onTime={followMaterial}
          rate={playback.rate}
          url={viewedMaterial.url}
          view={materialView}
        />
      )}
      <PreviewTransport
        {...transportSource}
        fullscreen={fullscreen}
        fullscreenBlocked={fullscreenBlocked}
        layer={fullscreen ? stage : null}
        onFullscreen={toggleFullscreen}
        onLoop={toggleLoop}
        onMute={toggleMute}
        onPlay={togglePlay}
        onRate={(rate) => setPlayback((current) => ({ ...current, rate }))}
        playback={playback}
      />
    </div>
  )
}
