from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Final

from iclip.domains.generation.film_schemas import WholeFilmFont, WholeFilmRequest
from iclip.domains.generation.segment_end import exceeds_source
from iclip.platform.media.audio import (
    AudioBed,
    AudioClip,
    VolumePoint,
    gain_to,
    integrated_loudness,
    mix_audio,
)
from iclip.platform.media.captions import (
    Caption,
    CaptionFont,
    CaptionStyle,
    EstimatedCaptionFont,
    ShapedCaptionFont,
    ass_document,
)
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fonts import FontError, inspect_font, prepare_font
from iclip.platform.media.probe import has_audio_stream, probe_duration_ms, probe_video
from iclip.platform.media.process import require_subtitles_filter
from iclip.platform.media.video import MediaCut, check_cut, encode_timeline

CAPTION_STYLE: Final = CaptionStyle(
    font_size_of_height=0.045,
    outline_of_font_size=0.08,
    bottom_margin_of_height=0.12,
    side_margin_of_width=0.06,
)

# 镜像里 apt 装的 fonts-noto-cjk。
DEFAULT_CAPTION_FONT: Final = EstimatedCaptionFont(
    family="Noto Sans CJK SC", fonts_dir=Path("/usr/share/fonts/opentype/noto")
)

_PROBED_DURATION_PRECISION_SECONDS: Final = 0.001


class MusicTooShort(MediaError):
    pass


def subtitle_font(request: WholeFilmRequest) -> WholeFilmFont | None:
    return request.font if request.subtitles else None


async def render_whole_film(
    request: WholeFilmRequest,
    *,
    files: Mapping[str, Path],
    dest: Path,
    codec: MediaCodec,
    workdir: Path,
    report_processing: Callable[[], Awaitable[None]],
) -> None:
    font_snapshot = subtitle_font(request)
    if font_snapshot is not None:
        await _check_font_snapshot(files[font_snapshot.url], font_snapshot)
    segments = [
        MediaCut(
            source=files[segment.url], start=segment.start_ms / 1000, end=segment.end_ms / 1000
        )
        for segment in request.segments
    ]
    profile = await probe_video(segments[0].source)
    await report_processing()

    caption_font: CaptionFont | None = None
    if request.subtitles:
        await require_subtitles_filter()
        caption_font = (
            DEFAULT_CAPTION_FONT
            if font_snapshot is None
            else ShapedCaptionFont(
                await asyncio.to_thread(
                    prepare_font,
                    files[font_snapshot.url],
                    texts=[line.text for line in request.subtitles],
                    directory=workdir / "subtitle-font",
                )
            )
        )
    for cut in segments:
        check_cut(cut)
    intro = None if request.intro is None else files[request.intro.url]
    outro = None if request.outro is None else files[request.outro.url]
    brands = [brand for brand in (intro, outro) if brand is not None]
    for brand in brands:
        if not brand.is_file():
            raise MediaError(f"片头片尾的素材不在: {brand.name}")
    sources = list(dict.fromkeys([*brands, *(cut.source for cut in segments)]))
    lengths_ms = {source: await probe_duration_ms(source) for source in sources}
    lengths = {source: length_ms / 1000 for source, length_ms in lengths_ms.items()}
    for position, (segment, cut) in enumerate(zip(request.segments, segments, strict=True), 1):
        if exceeds_source(segment.end_ms, lengths_ms[cut.source]):
            raise MediaError(
                f"第 {position} 段的结尾 {cut.end:.3f} 秒超出了素材的时长 "
                f"{lengths[cut.source]:.3f} 秒"
            )
    head = [] if intro is None else [MediaCut(source=intro, start=0.0, end=lengths[intro])]
    tail = [] if outro is None else [MediaCut(source=outro, start=0.0, end=lengths[outro])]
    timeline = [*head, *segments, *tail]
    volumes = [
        *(1.0 for _ in head),
        *(segment.volume for segment in request.segments),
        *(1.0 for _ in tail),
    ]
    segments_start = head[0].duration if head else 0.0
    segments_length = sum(cut.duration for cut in segments)
    render = request.render

    speech_gains: dict[Path, float | None] = {}
    for source in sources:
        audible = (await probe_video(source)).has_audio
        speech_gains[source] = (
            gain_to(await integrated_loudness(source), render.speech_loudness_lufs)
            if audible
            else None
        )
    clips = [
        AudioClip(
            source=cut.source,
            start=cut.start,
            end=cut.end,
            has_audio=speech_gains[cut.source] is not None,
            gain_db=speech_gains[cut.source] or 0.0,
            volume=volume,
        )
        for cut, volume in zip(timeline, volumes, strict=True)
    ]

    bed: AudioBed | None = None
    if request.music is not None:
        music = files[request.music.url]
        if not await has_audio_stream(music):
            raise MediaError("音乐里没有音轨")
        music_length = await probe_duration_ms(music) / 1000
        offset = request.music.offset_ms / 1000
        if offset + segments_length > music_length + _PROBED_DURATION_PRECISION_SECONDS:
            raise MusicTooShort(
                f"音乐从 {offset:.3f} 秒起只剩 {max(0.0, music_length - offset):.3f} 秒，"
                f"不够整片的 {segments_length:.3f} 秒"
            )
        bed = AudioBed(
            source=music,
            offset=offset,
            length=segments_length,
            gain_db=gain_to(await integrated_loudness(music), render.music_loudness_lufs),
            volume=request.music.volume,
            curve=[VolumePoint(point.at_ms / 1000, point.gain) for point in request.music.gain],
            fade_out=render.music_fade_out_ms / 1000,
            delay=segments_start,
        )

    edge_fade = render.segment_fade_ms / 1000
    mixed = workdir / "film-audio.wav"
    await mix_audio(clips, edge_fade=edge_fade, bed=bed, dest=mixed)
    reference = mixed
    if any(clip.volume != 1.0 for clip in clips) or (bed is not None and bed.volume != 1.0):
        # ADR-0004
        reference = workdir / "film-audio-reference.wav"
        await mix_audio(
            [replace(clip, volume=1.0) for clip in clips],
            edge_fade=edge_fade,
            bed=None if bed is None else replace(bed, volume=1.0),
            dest=reference,
        )
    film_gain = gain_to(await integrated_loudness(reference), render.loudness_lufs)

    burn = None
    if caption_font is not None:
        document = workdir / "film-captions.ass"
        captions = [
            Caption(
                start=line.start_ms / 1000 + segments_start,
                end=line.end_ms / 1000 + segments_start,
                text=line.text,
            )
            for line in request.subtitles
        ]
        document.write_text(
            ass_document(
                captions,
                width=profile.width,
                height=profile.height,
                style=CAPTION_STYLE,
                font=caption_font,
            ),
            encoding="utf-8",
        )
        burn = caption_font.burn(document)
    await encode_timeline(
        timeline,
        audio=mixed,
        gain_db=film_gain,
        peak_dbfs=render.peak_dbfs,
        subtitles=burn,
        profile=profile,
        dest=dest,
        codec=codec,
    )


async def _check_font_snapshot(path: Path, snapshot: WholeFilmFont) -> None:
    actual = await asyncio.to_thread(inspect_font, path)
    if (actual.family, actual.weight, actual.style) != (
        snapshot.family,
        snapshot.weight,
        snapshot.style,
    ):
        raise FontError("字体文件属性与受理时的快照不一致，请重新选择字体")


__all__ = [
    "CAPTION_STYLE",
    "DEFAULT_CAPTION_FONT",
    "MusicTooShort",
    "render_whole_film",
    "subtitle_font",
]
