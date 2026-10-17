from __future__ import annotations

import itertools
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, NamedTuple

from iclip.platform.media.errors import MediaError, NoAudioStream
from iclip.platform.media.fetch import MAX_AUDIO_BYTES, MAX_VIDEO_BYTES
from iclip.platform.media.probe import has_audio_stream, probe_duration_ms
from iclip.platform.media.process import ENCODE_TIMEOUT_SECONDS, check_output, communicate, run

AUDIO_CODEC: Final = ("-c:a", "aac", "-b:a", "192k")
AUDIO_RATE: Final = 48000
AUDIO_LAYOUT: Final = "stereo"
_STEREO: Final = f"aformat=sample_rates={AUDIO_RATE}:channel_layouts={AUDIO_LAYOUT}"

SPEECH_SAMPLE_RATE: Final = 16000
SPEECH_BITRATE: Final = "64k"

MUSIC_SILENCE_THRESHOLD_DB: Final = -50
MUSIC_LOUDNESS_LUFS: Final = -16.0
# AAC 编码后的峰值会比编码前高一些，不留余量解码出来会削波。
MUSIC_TRUE_PEAK_DBTP: Final = -1.5
# 线性缩放用不上它；只有缩放会超出真峰值、loudnorm 退回动态处理时才起作用。取 loudnorm 的默认值。
MUSIC_LOUDNESS_RANGE: Final = 11.0

MAX_LOUDNESS_BOOST_DB: Final = 20.0

# 倒过来再去一次开头，即去掉结尾。不用 stop_periods：它会连乐曲中间的停顿一起删。
_TRIM_MUSIC_SILENCE: Final = (
    f"silenceremove=start_periods=1:start_threshold={MUSIC_SILENCE_THRESHOLD_DB}dB,"
    "areverse,"
    f"silenceremove=start_periods=1:start_threshold={MUSIC_SILENCE_THRESHOLD_DB}dB,"
    "areverse"
)

_LOUDNESS_KEYS: Final = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")

# volume 的 eval=frame 按音频帧求值；帧切成 10 毫秒，曲线的台阶小到听不出。
_CURVE_FRAME_SAMPLES: Final = AUDIO_RATE // 100


@dataclass(frozen=True, slots=True)
class AudioClip:
    source: Path
    start: float
    end: float
    has_audio: bool
    gain_db: float
    volume: float

    @property
    def duration(self) -> float:
        return self.end - self.start


class VolumePoint(NamedTuple):
    seconds_into_bed: float
    linear_gain: float


@dataclass(frozen=True, slots=True)
class AudioBed:
    source: Path
    offset: float
    length: float
    gain_db: float
    volume: float
    curve: Sequence[VolumePoint]
    fade_out: float
    delay: float


async def extract_speech_audio(source: Path, *, dest: Path) -> None:
    if not source.is_file():
        raise MediaError(f"要抽音频的素材不在: {source.name}")
    if not await has_audio_stream(source):
        raise NoAudioStream(f"这条素材里没有音轨: {source.name}")
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source),
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SPEECH_SAMPLE_RATE),
            "-c:a", "libmp3lame", "-b:a", SPEECH_BITRATE, "-f", "mp3", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_VIDEO_BYTES)


async def normalize_music(source: Path, *, dest: Path) -> int:
    if not source.is_file():
        raise MediaError(f"要规整的音频不在: {source.name}")
    if not await has_audio_stream(source):
        raise NoAudioStream(f"这段素材里没有音轨: {source.name}")
    measured = await _measure_music_loudness(source)
    loudnorm = (
        f"loudnorm=I={MUSIC_LOUDNESS_LUFS}:TP={MUSIC_TRUE_PEAK_DBTP}:LRA={MUSIC_LOUDNESS_RANGE}"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true"
    )
    # loudnorm 在内部升到 192 kHz 处理，输出要重采样回来。编成 AAC 而不是 mp3：mp3 编码器在开头
    # 补的延迟没有标准的标注方式，播放时整段会往后推几十毫秒。
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0", "-vn",
            "-af", f"{_TRIM_MUSIC_SILENCE},{loudnorm},aresample={AUDIO_RATE}",
            "-ac", "2", "-ar", str(AUDIO_RATE), *AUDIO_CODEC,
            "-movflags", "+faststart", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_AUDIO_BYTES)
    return await probe_duration_ms(dest)


async def _measure_music_loudness(source: Path) -> dict[str, float]:
    measured = await _loudnorm_measure(
        source,
        f"{_TRIM_MUSIC_SILENCE},loudnorm=I={MUSIC_LOUDNESS_LUFS}"
        f":TP={MUSIC_TRUE_PEAK_DBTP}:LRA={MUSIC_LOUDNESS_RANGE}:print_format=json",
    )
    if not all(math.isfinite(value) for value in measured.values()):
        raise MediaError("这段音频去掉首尾静音后没有声音")
    return measured


async def _loudnorm_measure(source: Path, audio_filter: str) -> dict[str, float]:
    _, stderr = await communicate(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(source), "-map", "0:a:0", "-vn",
            "-af", audio_filter, "-f", "null", "-",
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    # loudnorm 只把测量结果以 JSON 写在 stderr 的末尾；静音量出来是 -inf。
    text = stderr.decode(errors="replace")
    start, end = text.rfind("{"), text.rfind("}")
    try:
        report = json.loads(text[start : end + 1]) if 0 <= start < end else None
        measured = {key: float(report[key]) for key in _LOUDNESS_KEYS} if report else None
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("loudnorm 的测量结果看不懂") from exc
    if measured is None:
        raise MediaError("loudnorm 没有给出测量结果")
    return measured


async def integrated_loudness(source: Path) -> float:
    measured = await _loudnorm_measure(source, "loudnorm=print_format=json")
    return measured["input_i"]


def gain_to(measured: float, target: float) -> float:
    if not math.isfinite(measured):
        return 0.0
    return min(target - measured, MAX_LOUDNESS_BOOST_DB)


async def mix_audio(
    clips: Sequence[AudioClip], *, edge_fade: float, bed: AudioBed | None, dest: Path
) -> None:
    inputs: list[str] = []
    chains: list[str] = []
    for index, clip in enumerate(clips):
        length = clip.duration
        if not clip.has_audio:
            chains.append(
                f"anullsrc=channel_layout={AUDIO_LAYOUT}:sample_rate={AUDIO_RATE},"
                f"atrim=duration={length:.3f}[s{index}]"
            )
            continue
        # 滤镜图里一路输入只能接一次，同一条来源取几段就开几路。
        inputs += ["-i", str(clip.source)]
        fade = min(edge_fade, length / 2)
        chain = (
            f"[{len(inputs) // 2 - 1}:a]atrim=start={clip.start:.3f}:end={clip.end:.3f},"
            f"asetpts=PTS-STARTPTS,{_STEREO},apad=whole_dur={length:.3f},"
            f"atrim=duration={length:.3f},volume={clip.gain_db:.2f}dB,volume={clip.volume:.6g}"
        )
        if fade > 0:
            chain += f",afade=t=in:d={fade:.3f},afade=t=out:st={length - fade:.3f}:d={fade:.3f}"
        chains.append(f"{chain}[s{index}]")
    chains.append(
        f"{''.join(f'[s{index}]' for index in range(len(clips)))}"
        f"concat=n={len(clips)}:v=0:a=1[track]"
    )
    output = "[track]"
    if bed is not None:
        fade = min(bed.fade_out, bed.length)
        inputs += ["-i", str(bed.source)]
        delay = round(bed.delay * 1000)
        shift = f",adelay=delays={delay}|{delay}" if delay > 0 else ""
        chains.append(
            f"[{len(inputs) // 2 - 1}:a]atrim=start={bed.offset:.3f}:duration={bed.length:.3f},"
            f"asetpts=PTS-STARTPTS,{_STEREO},volume={bed.gain_db:.2f}dB,volume={bed.volume:.6g},"
            f"asetnsamples=n={_CURVE_FRAME_SAMPLES}:p=0,"
            f"volume='{_curve_expression(bed.curve)}':eval=frame,"
            f"afade=t=out:st={bed.length - fade:.3f}:d={fade:.3f}{shift}[bed]"
        )
        # duration=first：混音与片段音轨等长，铺底先结束时后面只剩片段音轨。
        chains.append("[track][bed]amix=inputs=2:duration=first:normalize=0[mix]")
        output = "[mix]"
    # 32 位浮点：混音可能超过满幅，留给之后的限幅处理，不在这里削波。
    await run(
        [
            "ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chains),
            "-map", output, "-c:a", "pcm_f32le", "-ar", str(AUDIO_RATE), "-ac", "2", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_VIDEO_BYTES)


def _curve_expression(points: Sequence[VolumePoint]) -> str:
    # 各段平铺相加、不嵌套：ffmpeg 的表达式解析器是递归的，几百个点嵌套会过深。
    (_, first), *_ = points
    terms = [f"{first:.6g}"]
    for (start, before), (end, after) in itertools.pairwise(points):
        terms.append(f"({after - before:.6g})*clip((t-{start:.6g})/{end - start:.6g},0,1)")
    return "+".join(terms)


__all__ = [
    "AUDIO_CODEC",
    "AUDIO_LAYOUT",
    "AUDIO_RATE",
    "MAX_LOUDNESS_BOOST_DB",
    "MUSIC_LOUDNESS_LUFS",
    "MUSIC_LOUDNESS_RANGE",
    "MUSIC_SILENCE_THRESHOLD_DB",
    "MUSIC_TRUE_PEAK_DBTP",
    "SPEECH_BITRATE",
    "SPEECH_SAMPLE_RATE",
    "AudioBed",
    "AudioClip",
    "VolumePoint",
    "extract_speech_audio",
    "gain_to",
    "integrated_loudness",
    "mix_audio",
    "normalize_music",
]
