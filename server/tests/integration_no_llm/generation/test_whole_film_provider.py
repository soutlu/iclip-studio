"""用真实 ffmpeg 剪整片：多段首尾相接、画幅取第一段、没有音轨的段补静音、原声统一响度、音乐按起点截取
并按曲线压低、结尾淡出、音乐不够长与段超出素材明确失败，以及字幕真的烧进了画面。

整片先把素材下到本地，httpx 替身喂字节就够。"""

from __future__ import annotations

import re
import subprocess
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest

from iclip.domains.generation.processing import FfmpegComposeProvider
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import FILM_LOUDNESS_LUFS, ClipStage
from iclip.platform.media.codec import SOFTWARE, MediaCodec
from iclip.platform.media.ffmpeg import ffmpeg_available, probe_video
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import MemoryObjectStore, make_job, whole_film_request
from tests.helpers.media import (
    BROKEN_DECODE,
    CODECS,
    decode_all,
    duration_ms_of,
    has_subtitles_filter,
    local_codec,
    synthesize_padded_music,
    synthesize_video,
)

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

SPEECH_URL = "https://example.test/speech.mp4"
"""320×240、4 秒、带一条 440 Hz 的音轨：当成有口播的成片。"""
SILENT_URL = "https://example.test/silent.mp4"
"""480×360、3 秒、没有音轨。"""
MUSIC_URL = "https://example.test/music.wav"
"""10 秒：前 2 秒静音，后 8 秒是音。"""
INTRO_URL = "https://example.test/brand/intro.mp4"
"""片头模板：240×320 竖屏、2 秒、没有音轨。"""
OUTRO_URL = "https://example.test/brand/outro.mp4"
"""片尾模板：320×240、1 秒、没有音轨。"""
JINGLE_URL = "https://example.test/brand/jingle.mp4"
"""带声音的片头模板：320×240、1 秒、一条 440 Hz 的音轨。"""

SILENCE_DB = -60.0
"""平均电平低于它就当静音：真静音量出来约 -91 dB。"""


@pytest.fixture(scope="module")
def sources() -> dict[str, bytes]:
    with TemporaryDirectory(prefix="film-fixture-") as tmp:
        root = Path(tmp)
        return {
            SPEECH_URL: synthesize_video(
                root / "speech.mp4", size="320x240", seconds=4, audio=True
            ),
            SILENT_URL: synthesize_video(
                root / "silent.mp4", size="480x360", seconds=3, audio=False
            ),
            MUSIC_URL: synthesize_padded_music(root / "music.wav", lead=2, body=8, tail=0),
            INTRO_URL: synthesize_video(root / "intro.mp4", size="240x320", seconds=2, audio=False),
            OUTRO_URL: synthesize_video(root / "outro.mp4", size="320x240", seconds=1, audio=False),
            JINGLE_URL: synthesize_video(
                root / "jingle.mp4", size="320x240", seconds=1, audio=True
            ),
        }


def _brand(url: str, *, duration_ms: int, size: tuple[int, int], audio: bool) -> dict[str, Any]:
    """受理时记下的模板快照。"""

    width, height = size
    return {
        "url": url,
        "durationMs": duration_ms,
        "width": width,
        "height": height,
        "hasAudio": audio,
    }


SILENT_INTRO = _brand(INTRO_URL, duration_ms=2000, size=(240, 320), audio=False)
SILENT_OUTRO = _brand(OUTRO_URL, duration_ms=1000, size=(320, 240), audio=False)
JINGLE_INTRO = _brand(JINGLE_URL, duration_ms=1000, size=(320, 240), audio=True)


def _transport(payloads: Mapping[str, bytes]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        body = payloads.get(str(request.url))
        return httpx.Response(404) if body is None else httpx.Response(200, content=body)

    return httpx.MockTransport(handler)


class _Stages:
    def __init__(self) -> None:
        self.seen: list[ClipStage] = []

    async def report(self, job_id: uuid.UUID, stage: ClipStage) -> bool:
        self.seen.append(stage)
        return True


async def _render(
    sources: Mapping[str, bytes],
    segments: Sequence[Mapping[str, Any]],
    *,
    subtitles: Sequence[Mapping[str, Any]] = (),
    music: Mapping[str, Any] | None = None,
    intro: Mapping[str, Any] | None = None,
    outro: Mapping[str, Any] | None = None,
    stages: _Stages | None = None,
    codec: MediaCodec = SOFTWARE,
) -> bytes:
    """跑一次整片，交回存进桶的产物字节。"""

    store = MemoryObjectStore()
    provider = FfmpegComposeProvider(
        object_store=store,
        report_stage=(stages or _Stages()).report,
        codec=codec,
        fetch_url=as_is,
        transport=_transport(sources),
    )
    job = make_job(
        whole_film_request(segments, subtitles=subtitles, music=music, intro=intro, outro=outro),
        provider="ffmpeg",
        conversation_id=uuid.uuid4(),
    )
    submission = await provider.submit(job)
    ((key, (content, content_type)),) = store.objects.items()
    assert content_type == "video/mp4"
    assert key.endswith(f"{job.id}.mp4"), "整片同合成一样按记录 id 存成片"
    assert submission.output_url == store.public_url(key)
    assert submission.duration_ms == await duration_ms_of(content)
    return content


def _saved(content: bytes, root: Path, name: str = "film.mp4") -> Path:
    path = root / name
    path.write_bytes(content)
    return path


def _mean_volume(path: Path, *, start: float, length: float) -> float:
    """``[start, start+length)`` 这一段声音的平均电平（dB）。"""

    run = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start}", "-t", f"{length}",
            "-i", str(path), "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    (found,) = re.findall(r"mean_volume: (-?[\d.]+|-inf) dB", run.stderr.decode())
    return float(found)


def _loudness(path: Path) -> float:
    """整条的综合响度（LUFS），用 ebur128 滤镜量，与被测代码用的 loudnorm 是两套实现。"""

    run = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-af",
            "ebur128",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", run.stderr.decode())[-1])


def _gray_frame(path: Path, *, at: float) -> bytes:
    """``at`` 秒那一帧的灰度像素。"""

    return subprocess.run(
        [
            "ffmpeg", "-v", "error", "-ss", f"{at}", "-i", str(path), "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        check=True,
        capture_output=True,
    ).stdout  # fmt: skip


async def test_segments_join_end_to_end_at_the_first_segments_frame_and_silence_fills_the_gaps(
    sources: dict[str, bytes],
) -> None:
    stages = _Stages()
    content = await _render(
        sources,
        [
            {"url": SPEECH_URL, "startMs": 0, "endMs": 1000},
            {"url": SILENT_URL, "startMs": 500, "endMs": 2500},
            {"url": SPEECH_URL, "startMs": 2000, "endMs": 3500},
        ],
        stages=stages,
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        film = _saved(content, Path(tmp))
        profile = await probe_video(film)
        assert abs(await duration_ms_of(content) - 4500) <= 100, "整片总长是各段时长之和"
        assert (profile.width, profile.height, profile.has_audio) == (320, 240, True)
        assert _mean_volume(film, start=0.2, length=0.6) > SILENCE_DB
        assert _mean_volume(film, start=1.2, length=1.6) < SILENCE_DB, "没有音轨的段补静音"
        assert _mean_volume(film, start=3.2, length=1.0) > SILENCE_DB
    assert stages.seen == ["fetching", "processing", "uploading"]


@pytest.mark.parametrize("name", list(CODECS))
async def test_every_codec_renders_a_film_with_music(sources: dict[str, bytes], name: str) -> None:
    """每一档编解码都剪得出带音乐的整片：解码选项只加在各段视频输入前，混好的声音那一路不带它。
    本机用不了的硬件档跳过。"""

    codec = local_codec(name)
    content = await _render(
        sources,
        [
            {"url": SPEECH_URL, "startMs": 0, "endMs": 1000},
            {"url": SILENT_URL, "startMs": 0, "endMs": 1000},
        ],
        music={"url": MUSIC_URL, "offsetMs": 2000, "gain": [{"atMs": 0, "gain": 0.5}]},
        codec=codec,
    )

    assert abs(await duration_ms_of(content) - 2000) <= 100
    await decode_all(content, codec)


async def test_the_decode_options_reach_every_segment_input(sources: dict[str, bytes]) -> None:
    with pytest.raises(ProviderError) as failure:
        await _render(
            sources, [{"url": SILENT_URL, "startMs": 0, "endMs": 1000}], codec=BROKEN_DECODE
        )

    assert failure.value.code == "MEDIA_PROCESS_FAILED"


async def test_the_frame_follows_the_first_segment_not_the_longest(
    sources: dict[str, bytes],
) -> None:
    content = await _render(
        sources,
        [
            {"url": SILENT_URL, "startMs": 0, "endMs": 1000},
            {"url": SPEECH_URL, "startMs": 0, "endMs": 3000},
        ],
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        profile = await probe_video(_saved(content, Path(tmp)))
    assert (profile.width, profile.height) == (480, 360)


async def test_the_film_lands_on_the_film_loudness(sources: dict[str, bytes]) -> None:
    content = await _render(sources, [{"url": SPEECH_URL, "startMs": 0, "endMs": 4000}])

    with TemporaryDirectory(prefix="film-out-") as tmp:
        loudness = _loudness(_saved(content, Path(tmp)))
    assert abs(loudness - FILM_LOUDNESS_LUFS) <= 1.0, loudness


async def test_music_starts_at_its_offset_and_fades_out_at_the_end(
    sources: dict[str, bytes],
) -> None:
    """音乐前 2 秒是静音：从 2 秒起用，整片一开头就有音乐；从 0 起用，开头就是那段静音。"""

    silent_film = [{"url": SILENT_URL, "startMs": 0, "endMs": 3000}]
    from_offset = await _render(
        sources,
        silent_film,
        music={"url": MUSIC_URL, "offsetMs": 2000, "gain": [{"atMs": 0, "gain": 1}]},
    )
    from_start = await _render(
        sources,
        silent_film,
        music={"url": MUSIC_URL, "offsetMs": 0, "gain": [{"atMs": 0, "gain": 1}]},
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        offset_film = _saved(from_offset, Path(tmp), "offset.mp4")
        start_film = _saved(from_start, Path(tmp), "start.mp4")
        body = _mean_volume(offset_film, start=0.2, length=0.6)
        assert body > SILENCE_DB
        assert _mean_volume(start_film, start=0.2, length=0.6) < SILENCE_DB
        tail = _mean_volume(offset_film, start=2.7, length=0.25)
        assert tail < body - 6, f"结尾 2 秒淡出：{tail} dB 对比 {body} dB"


async def test_the_gain_curve_lowers_the_music_where_it_dips(sources: dict[str, bytes]) -> None:
    content = await _render(
        sources,
        [{"url": SILENT_URL, "startMs": 0, "endMs": 3000}],
        music={
            "url": MUSIC_URL,
            "offsetMs": 2000,
            "gain": [
                {"atMs": 0, "gain": 1},
                {"atMs": 1000, "gain": 1},
                {"atMs": 1100, "gain": 0.1},
                {"atMs": 1900, "gain": 0.1},
                {"atMs": 2000, "gain": 1},
            ],
        },
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        film = _saved(content, Path(tmp))
        loud = _mean_volume(film, start=0.2, length=0.6)
        ducked = _mean_volume(film, start=1.25, length=0.5)
    # 0.1 倍是 -20 dB；按帧求值与编码会抹掉一点，不到 15 dB 就是曲线没生效。
    assert ducked < loud - 15, f"压低处 {ducked} dB 对比 {loud} dB"


async def test_music_that_is_too_short_fails_the_film(sources: dict[str, bytes]) -> None:
    with pytest.raises(ProviderError) as failure:
        await _render(
            sources,
            [{"url": SILENT_URL, "startMs": 0, "endMs": 3000}],
            music={"url": MUSIC_URL, "offsetMs": 8000, "gain": [{"atMs": 0, "gain": 1}]},
        )

    assert (failure.value.code, failure.value.retryable) == ("MUSIC_TOO_SHORT", False)


async def test_a_segment_past_the_end_of_its_source_fails_the_film(
    sources: dict[str, bytes],
) -> None:
    with pytest.raises(ProviderError) as failure:
        await _render(sources, [{"url": SILENT_URL, "startMs": 0, "endMs": 3500}])

    assert failure.value.code == "MEDIA_PROCESS_FAILED"
    assert "超出了素材的时长" in str(failure.value)


async def test_an_unreachable_source_fails_the_film(sources: dict[str, bytes]) -> None:
    with pytest.raises(ProviderError) as failure:
        await _render(
            sources, [{"url": "https://example.test/gone.mp4", "startMs": 0, "endMs": 1000}]
        )

    assert failure.value.code == "MEDIA_SOURCE_UNREACHABLE"


@pytest.mark.skipif(
    not has_subtitles_filter(),
    reason="本机 ffmpeg 没有 libass 的 subtitles 滤镜（如 Homebrew 的精简版 ffmpeg），烧不了字幕",
)
async def test_subtitles_are_burned_into_the_bottom_of_the_picture(
    sources: dict[str, bytes],
) -> None:
    segments = [{"url": SILENT_URL, "startMs": 0, "endMs": 2000}]
    with_text = await _render(
        sources,
        segments,
        subtitles=[{"startMs": 500, "endMs": 1500, "text": "整片的字幕烧进了画面"}],
    )
    without = await _render(sources, segments)

    with TemporaryDirectory(prefix="film-out-") as tmp:
        root = Path(tmp)
        burned = _gray_frame(_saved(with_text, root, "with.mp4"), at=1.0)
        plain = _gray_frame(_saved(without, root, "without.mp4"), at=1.0)
        before = _gray_frame(_saved(with_text, root, "with.mp4"), at=0.2)
        plain_before = _gray_frame(_saved(without, root, "without.mp4"), at=0.2)
    width, height = 480, 360
    assert len(burned) == len(plain) == width * height

    def changed(left: bytes, right: bytes, rows: range) -> int:
        return sum(
            1
            for row in rows
            for column in range(width)
            if abs(left[row * width + column] - right[row * width + column]) > 60
        )

    bottom, top = range(height * 2 // 3, height), range(height // 3)
    # 360 高的画面字号 14，十个字描了边，变化的像素有几百个；画面上别处应当一个都不变。
    assert changed(burned, plain, bottom) > 150, "字幕那一句的时段里，画面下方有字"
    assert changed(burned, plain, top) < 30, "上方不受影响"
    assert changed(before, plain_before, bottom) < 30, "字幕开始之前没有字"


# --- 片头片尾 --------------------------------------------------------------------


async def test_intro_and_outro_sit_at_both_ends_and_the_music_only_under_the_segments(
    sources: dict[str, bytes],
) -> None:
    """片头 2 秒、段 3 秒、片尾 1 秒，都没有音轨：音乐的时刻从第一段开头算，只铺在段上；片头片尾
    补的是静音。画幅仍取第一段，不取片头。"""

    content = await _render(
        sources,
        [{"url": SILENT_URL, "startMs": 0, "endMs": 3000}],
        music={"url": MUSIC_URL, "offsetMs": 2000, "gain": [{"atMs": 0, "gain": 1}]},
        intro=SILENT_INTRO,
        outro=SILENT_OUTRO,
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        film = _saved(content, Path(tmp))
        profile = await probe_video(film)
        assert abs(await duration_ms_of(content) - 6000) <= 100, "片头 + 各段 + 片尾"
        assert (profile.width, profile.height) == (480, 360), "画幅取第一段，不取片头"
        intro_level = _mean_volume(film, start=0.2, length=1.6)
        segment_level = _mean_volume(film, start=2.2, length=0.6)
        outro_level = _mean_volume(film, start=5.2, length=0.6)
    assert intro_level < SILENCE_DB, f"片头上没有音乐：{intro_level} dB"
    assert segment_level > SILENCE_DB, f"音乐从第一段开头起：{segment_level} dB"
    assert outro_level < SILENCE_DB, f"片尾上没有音乐：{outro_level} dB"


async def test_a_template_with_sound_keeps_it(sources: dict[str, bytes]) -> None:
    content = await _render(
        sources, [{"url": SILENT_URL, "startMs": 0, "endMs": 1000}], intro=JINGLE_INTRO
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        film = _saved(content, Path(tmp))
        assert abs(await duration_ms_of(content) - 2000) <= 100
        assert _mean_volume(film, start=0.2, length=0.6) > SILENCE_DB, "片头用模板自带的声音"
        assert _mean_volume(film, start=1.2, length=0.6) < SILENCE_DB, "没有音轨的段补静音"


async def test_the_intro_picture_comes_first_and_the_outro_last(sources: dict[str, bytes]) -> None:
    """片头竖屏缩进横屏画幅，两边补黑；段本身铺满画面。"""

    content = await _render(
        sources,
        [{"url": SILENT_URL, "startMs": 0, "endMs": 1000}],
        intro=SILENT_INTRO,
        outro=SILENT_OUTRO,
    )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        film = _saved(content, Path(tmp))
        intro_frame = _gray_frame(film, at=1.0)
        segment_frame = _gray_frame(film, at=2.5)
    width, height = 480, 360

    def left_edge_dark(frame: bytes) -> bool:
        column = [frame[row * width + 5] for row in range(height)]
        return max(column) < 30

    assert left_edge_dark(intro_frame), "片头 240×320 缩进 480×360，左右补黑边"
    assert not left_edge_dark(segment_frame), "段与画幅同大，铺满"


@pytest.mark.skipif(
    not has_subtitles_filter(),
    reason="本机 ffmpeg 没有 libass 的 subtitles 滤镜（如 Homebrew 的精简版 ffmpeg），烧不了字幕",
)
async def test_subtitle_times_start_at_the_first_segment_and_skip_the_brand_clips(
    sources: dict[str, bytes],
) -> None:
    """字幕时刻 [0, 1000) 落在第一段的头一秒（片头之后），片头片尾上没有字。"""

    segments = [{"url": SILENT_URL, "startMs": 0, "endMs": 2000}]
    brands: dict[str, Any] = {"intro": SILENT_INTRO, "outro": SILENT_OUTRO}
    with_text = await _render(
        sources,
        segments,
        subtitles=[{"startMs": 0, "endMs": 1000, "text": "字幕跟着第一段走"}],
        **brands,
    )
    without = await _render(sources, segments, **brands)

    width, height = 480, 360
    bottom = range(height * 2 // 3, height)

    def changed(left: bytes, right: bytes) -> int:
        return sum(
            1
            for row in bottom
            for column in range(width)
            if abs(left[row * width + column] - right[row * width + column]) > 60
        )

    with TemporaryDirectory(prefix="film-out-") as tmp:
        root = Path(tmp)
        burned_film = _saved(with_text, root, "with.mp4")
        plain_film = _saved(without, root, "without.mp4")
        frames = {
            at: (_gray_frame(burned_film, at=at), _gray_frame(plain_film, at=at))
            for at in (1.0, 2.5, 4.5)
        }
    assert changed(*frames[1.0]) < 30, "片头上没有字"
    assert changed(*frames[2.5]) > 150, "第一段的头一秒有字"
    assert changed(*frames[4.5]) < 30, "片尾上没有字"
