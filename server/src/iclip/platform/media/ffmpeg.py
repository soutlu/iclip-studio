"""异步媒体下载与 ffmpeg/ffprobe 子进程封装，以及视频裁剪与拼接、剪整片（混音、烧字幕）、给语音识别
抽音频、规整背景音乐。

子进程设定超时，超时后先 kill 再 wait，避免阻塞事件循环或遗留僵尸进程。
按格取帧、灰度检测那些只有分镜取帧用得上的操作留在 capabilities 里。"""

from __future__ import annotations

import asyncio
import itertools
import json
import math
import re
import shutil
import unicodedata
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx

from iclip.common.urls import is_http_url
from iclip.platform.media.codec import MediaCodec

_STDERR_LIMIT = 400
_DOWNLOAD_CHUNK = 256 * 1024

PROBE_TIMEOUT_SECONDS = 30.0

ENCODE_TIMEOUT_SECONDS = 900.0
"""拼接要整条重编码的超时上限。"""

DOWNLOAD_TIMEOUT_SECONDS = 300.0

REMOTE_READ_TIMEOUT_SECONDS = 30.0
"""远程输入单次读写的等待上限，整段仍受调用方给 ``run`` 的超时约束。"""

_REMOTE_INPUT: Final = (
    # ffmpeg 按内容探测格式，一份伪装成 mp4 的播放列表会让 HLS 解复用器去跟里面的地址。
    "-protocol_whitelist",
    "http,https,tcp,tls",
    "-rw_timeout",
    str(int(REMOTE_READ_TIMEOUT_SECONDS * 1_000_000)),
    "-reconnect",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "5",
)
"""远程输入在 ``-i`` 之前要带的选项。"""

MAX_VIDEO_BYTES = 512 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024
"""下载大小上限，限制 worker 的内存与临时文件占用。音频按两分钟 48 kHz 双声道 wav（约 23 MB）留足余量。"""

_AUDIO_CODEC = ("-c:a", "aac", "-b:a", "192k")
_AUDIO_RATE = 48000
_AUDIO_LAYOUT = "stereo"

SPEECH_SAMPLE_RATE: Final = 16000
"""抽给语音识别的音频采样率（Hz）。"""

SPEECH_BITRATE: Final = "64k"
"""抽给语音识别的 mp3 码率。固定下来，产物大小只随时长变：5 分钟约 2.4 MB。"""

MUSIC_SILENCE_THRESHOLD_DB: Final = -50
"""规整背景音乐时，电平低于它（dBFS）的开头与结尾算静音、去掉。-50 dB 已听不见，又高于底噪与
淡出的尾巴，乐句里的弱音不会被当成静音；只去首尾，中间的停顿不动。"""

MUSIC_LOUDNESS_LUFS: Final = -16.0
"""背景音乐统一到的综合响度（LUFS，EBU R128 的测法）。-16 是移动端与网页节目常用的响度，留得出
动态余量；整片合成时音乐还要按口播压低、最后统一限幅，这里只是让每首音乐从同一个响度起步，
不是母带处理。"""

MUSIC_TRUE_PEAK_DBTP: Final = -1.5
"""规整后的真峰值上限（dBTP），给 AAC 编码后的峰值抬升留出余量，免得解码出来削波。"""

MUSIC_LOUDNESS_RANGE: Final = 11.0
"""loudnorm 的响度范围目标（LU）。按测量值线性缩放时不改动态，用不上它；只有线性缩放会超出真峰值、
loudnorm 退回动态处理时才起作用，取它的默认值。"""

_TRIM_MUSIC_SILENCE: Final = (
    f"silenceremove=start_periods=1:start_threshold={MUSIC_SILENCE_THRESHOLD_DB}dB,"
    "areverse,"
    f"silenceremove=start_periods=1:start_threshold={MUSIC_SILENCE_THRESHOLD_DB}dB,"
    "areverse"
)
"""去首尾静音：去掉开头的，倒过来再去一次开头（即原来的结尾），再倒回去。不用 ``stop_periods``：
它会连乐曲中间的停顿一起删。倒序要整段进内存，两分钟的双声道音频几十 MB，承受得起。"""

_LOUDNESS_KEYS: Final = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")


class MediaError(RuntimeError):
    """取素材或 ffmpeg 处理失败。"""


class NoAudioStream(MediaError):
    """素材里没有音轨，没有可抽的声音。"""


@dataclass(frozen=True, slots=True)
class VideoProfile:
    """一条视频的画面参数。拼接必须重编码，各段就靠它对齐。"""

    width: int
    height: int
    frame_rate: str
    """ffprobe 的分数写法，如 ``30000/1001``；原样交给 fps 滤镜。"""

    has_audio: bool


@dataclass(frozen=True, slots=True)
class MediaCut:
    """从一条素材里取 ``[start, end)`` 这一段。"""

    source: Path
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def ffmpeg_available() -> bool:
    """PATH 上同时有 ffmpeg 和 ffprobe。"""

    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@asynccontextmanager
async def fetched(
    client: httpx.AsyncClient, url: str, *, max_bytes: int, suffix: str = ""
) -> AsyncGenerator[Path]:
    """将素材流式下载到临时文件供 ffmpeg seek，退出上下文时清理目录。"""

    with TemporaryDirectory(prefix="iclip-media-") as tmp:
        target = Path(tmp) / f"source{suffix}"
        await download(client, url, target, max_bytes=max_bytes)
        yield target


async def download(client: httpx.AsyncClient, url: str, dest: Path, *, max_bytes: int) -> None:
    """流式下载到指定路径并限制总字节数；要几份素材放同一个临时目录时用它。"""

    written = 0
    try:
        async with client.stream("GET", url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            response.raise_for_status()
            with dest.open("wb") as handle:
                async for chunk in response.aiter_bytes(_DOWNLOAD_CHUNK):
                    written += len(chunk)
                    if written > max_bytes:
                        raise MediaError(f"素材超过 {max_bytes} 字节的上限: {url}")
                    handle.write(chunk)
    except httpx.HTTPError as exc:
        raise MediaError(f"取不到素材（{type(exc).__name__}）: {url}") from exc
    if written == 0:
        raise MediaError(f"取到的素材是空的: {url}")


_PROBE_DURATION: Final = (
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
)


async def probe_duration_ms(path: Path) -> int:
    """探测媒体时长（毫秒）。"""

    stdout = await run(
        ["ffprobe", "-v", "error", *_PROBE_DURATION, str(path)], timeout=PROBE_TIMEOUT_SECONDS
    )
    return _duration_ms(stdout)


async def probe_remote_duration_ms(url: str) -> int:
    """按需读远程视频探时长（毫秒），只取索引所需的字节，不整份下载。

    地址非法、取不到、超时或时长看不懂抛 MediaError；消息里的地址去掉查询串，签名不进日志。"""

    if not is_http_url(url):
        raise MediaError(f"要探的地址不是 http(s): {_safe_url(url)}")
    try:
        stdout = await run(
            ["ffprobe", "-v", "error", *_REMOTE_INPUT, *_PROBE_DURATION, url],
            timeout=PROBE_TIMEOUT_SECONDS,
        )
    except MediaError as exc:
        raise MediaError(str(exc).replace(url, _safe_url(url))) from exc
    return _duration_ms(stdout)


def _duration_ms(stdout: bytes) -> int:
    text = stdout.decode(errors="replace").strip()
    try:
        seconds = float(text)
    except ValueError as exc:
        raise MediaError(f"ffprobe 报的时长看不懂: {text!r}") from exc
    if seconds <= 0:
        raise MediaError(f"ffprobe 报的时长不是正数: {seconds}")
    return round(seconds * 1000)


async def probe_video(path: Path) -> VideoProfile:
    """读画幅、帧率与有没有音轨。"""

    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,r_frame_rate",
            "-of",
            "json",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        streams = json.loads(stdout)["streams"]
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("ffprobe 的流信息看不懂") from exc
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError(f"这条素材里没有视频流: {path.name}")
    width, height = video.get("width"), video.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise MediaError(f"ffprobe 报的画幅看不懂: {width!r}×{height!r}")
    rate = video.get("r_frame_rate")
    if not isinstance(rate, str) or not _positive_fraction(rate):
        raise MediaError(f"ffprobe 报的帧率看不懂: {rate!r}")
    return VideoProfile(
        width=width,
        height=height,
        frame_rate=rate,
        has_audio=any(item.get("codec_type") == "audio" for item in streams),
    )


async def probe_keyframes(path: Path) -> list[float]:
    """读第一条视频流的关键帧时刻（秒），从小到大。

    时刻从文件的起始时间算起，与 ffmpeg 读这条素材时 ``trim``、``-ss`` 用的是同一条时间轴。
    读的是容器里每个包的关键帧标记，不解码。没有视频流、一个关键帧都没有、或 ffprobe 读不了
    抛 MediaError。"""

    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=index:packet=pts_time,flags:format=start_time",
            "-of",
            "json",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        report = json.loads(stdout)
        streams = report["streams"]
        packets = report["packets"]
        start = float(report["format"].get("start_time", 0))
        keyframes = sorted(
            float(packet["pts_time"]) - start
            for packet in packets
            if "K" in packet.get("flags", "")
        )
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise MediaError("ffprobe 的关键帧信息看不懂") from exc
    if not streams:
        raise MediaError(f"这条素材里没有视频流: {path.name}")
    if not keyframes:
        raise MediaError(f"这条素材的视频流里没有关键帧: {path.name}")
    return keyframes


async def has_audio_stream(path: Path) -> bool:
    """素材里有没有音轨；读不了抛 MediaError。不要求有视频流，纯音频文件也认。"""

    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "json",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        streams = json.loads(stdout)["streams"]
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("ffprobe 的音轨信息看不懂") from exc
    return isinstance(streams, list) and len(streams) > 0


async def extract_speech_audio(source: Path, *, dest: Path) -> None:
    """把素材的第一条音轨抽成单声道、16 kHz、固定码率的 mp3，写到 ``dest``，给语音识别用。

    多声道混成单声道：说话人分离只收单声道。没有音轨抛 ``NoAudioStream``（调用方据此判断「没有
    口播」，不当成处理失败）；素材不在、读不了或 ffmpeg 失败抛 MediaError，产物为空也算失败。"""

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
    _check_output(dest, max_bytes=MAX_VIDEO_BYTES)


async def normalize_music(source: Path, *, dest: Path) -> int:
    """把一段音乐规整成背景音乐：去掉首尾静音、统一响度，编成 48 kHz 双声道 AAC 的 m4a 写到 ``dest``，
    返回产物量出来的时长（毫秒）。

    响度分两遍：第一遍量去掉静音之后的响度，第二遍按量出来的值线性缩放到
    ``MUSIC_LOUDNESS_LUFS``，不改乐曲本身的动态。两遍用同一段去静音的滤镜，量的就是缩放的那一段。
    loudnorm 在内部升到 192 kHz 处理，之后重采样回 48 kHz：与合成里音轨的采样率一致，混音不用再转。

    产物选 AAC：合成的音轨用的就是它，m4a 也是上传收的音频类型，浏览器都能解码；mp3 的编码器在
    开头补的那段延迟没有标准的方式标出来，播放时会把音乐整体往后推几十毫秒，对拍点不利。

    素材不在、没有音轨、去掉静音后什么都不剩、ffmpeg 失败或产物读不出时长都抛 MediaError。"""

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
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0", "-vn",
            "-af", f"{_TRIM_MUSIC_SILENCE},{loudnorm},aresample={_AUDIO_RATE}",
            "-ac", "2", "-ar", str(_AUDIO_RATE), *_AUDIO_CODEC,
            "-movflags", "+faststart", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    _check_output(dest, max_bytes=MAX_AUDIO_BYTES)
    return await probe_duration_ms(dest)


async def _measure_music_loudness(source: Path) -> dict[str, float]:
    """量去掉首尾静音之后的响度，交回 loudnorm 第二遍要的几个测量值。

    整段都是静音时 loudnorm 量出 ``-inf``，没有可以缩放的声音，抛 MediaError。"""

    measured = await _loudnorm_measure(
        source,
        f"{_TRIM_MUSIC_SILENCE},loudnorm=I={MUSIC_LOUDNESS_LUFS}"
        f":TP={MUSIC_TRUE_PEAK_DBTP}:LRA={MUSIC_LOUDNESS_RANGE}:print_format=json",
    )
    if not all(math.isfinite(value) for value in measured.values()):
        raise MediaError("这段音频去掉首尾静音后没有声音")
    return measured


async def _loudnorm_measure(source: Path, audio_filter: str) -> dict[str, float]:
    """让 ``source`` 的第一条音轨过一遍 ``audio_filter``（末尾是带 ``print_format=json`` 的 loudnorm），
    交回它量出的那几个值；静音量出来是 ``-inf``，原样交回。

    loudnorm 只把测量结果以 JSON 写在 stderr 的末尾；没有或看不懂抛 MediaError。"""

    _, stderr = await _communicate(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(source), "-map", "0:a:0", "-vn",
            "-af", audio_filter, "-f", "null", "-",
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
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
    """``source`` 第一条音轨整段的综合响度（LUFS，EBU R128 的测法，带门限，停顿不拉低它）；整段静音是
    ``-inf``。没有音轨或读不了抛 MediaError。"""

    measured = await _loudnorm_measure(source, "loudnorm=print_format=json")
    return measured["input_i"]


def _positive_fraction(value: str) -> bool:
    numerator, _, denominator = value.partition("/")
    try:
        return float(numerator) > 0 and float(denominator or 1) > 0
    except ValueError:
        return False


async def cut_concat(
    cuts: Sequence[MediaCut], *, profile: VideoProfile, dest: Path, codec: MediaCodec
) -> None:
    """按顺序裁出各段并拼成一条，一次解码重编码对齐到 ``profile``；解码与编码用 ``codec`` 这一档。

    各段来自不同素材、参数互不相同，所以走 ``concat`` 滤镜而不是 concat 分离器——后者要求
    各输入参数一致。``profile`` 要音轨而某一段没有时，那一段配一条等长静音。

    哪几段没有音轨在这里自己探一遍（每个源几十毫秒），不要调用方随 ``MediaCut`` 带进来：
    那会把「记住各段有没有音轨」变成调用方的义务，记错就是一条拼不出来的滤镜图。

    产物的关键帧只放在每段的起点和每段内素材原有的关键帧处，别处不放；
    素材的关键帧同样在这里自己读，算法见 ``_concat_keyframes``。"""

    if not cuts:
        raise MediaError("没有要拼的片段")
    for cut in cuts:
        _check_cut(cut)
    silent = [not (await probe_video(cut.source)).has_audio for cut in cuts]
    keyframes = _concat_keyframes(
        cuts,
        {source: await probe_keyframes(source) for source in {cut.source for cut in cuts}},
        frame_rate=Fraction(profile.frame_rate),
    )

    inputs: list[str] = []
    chains: list[str] = []
    labels: list[str] = []
    for index, cut in enumerate(cuts):
        inputs += [*codec.decode, "-i", str(cut.source)]
        chains.append(_video_chain(index, cut, profile))
        labels.append(f"[v{index}]")

    if profile.has_audio:
        for index, cut in enumerate(cuts):
            if silent[index]:
                # 静音源单独进一路 anullsrc，长度按这一段裁好，concat 才对得齐。
                source = f"[{len(cuts) + silent[:index].count(True)}:a]"
                inputs += [
                    "-f",
                    "lavfi",
                    "-t",
                    f"{cut.duration:.3f}",
                    "-i",
                    f"anullsrc=channel_layout={_AUDIO_LAYOUT}:sample_rate={_AUDIO_RATE}",
                ]
                chains.append(f"{source}asetpts=PTS-STARTPTS[a{index}]")
            else:
                chains.append(
                    f"[{index}:a]atrim=start={cut.start:.3f}:end={cut.end:.3f},"
                    f"asetpts=PTS-STARTPTS,"
                    f"aformat=sample_rates={_AUDIO_RATE}:channel_layouts={_AUDIO_LAYOUT}[a{index}]"
                )
            labels.insert(2 * index + 1, f"[a{index}]")

    chains.append(
        f"{''.join(labels)}concat=n={len(cuts)}:v=1:a={1 if profile.has_audio else 0}"
        f"[outv]{'[outa]' if profile.has_audio else ''}"
    )
    args = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chains)]
    args += ["-map", "[outv]"]
    if profile.has_audio:
        args += ["-map", "[outa]", *_AUDIO_CODEC]
    args += [*codec.encode, "-force_key_frames", keyframes]
    args += ["-movflags", "+faststart", str(dest)]
    await run(args, timeout=ENCODE_TIMEOUT_SECONDS)
    _check_output(dest, max_bytes=MAX_VIDEO_BYTES)


def _video_chain(index: int, cut: MediaCut, profile: VideoProfile) -> str:
    """第 ``index`` 个输入的画面裁出 ``cut`` 这一段，对齐到 ``profile``，输出标签 ``[v{index}]``：
    等比缩进画幅、不足处补黑边，统一帧率、像素格式与像素比。"""

    return (
        f"[{index}:v]trim=start={cut.start:.3f}:end={cut.end:.3f},setpts=PTS-STARTPTS,"
        # 模型还回来的片段分辨率档位比原片高，这一步多半在下采样，lanczos 比默认的
        # bicubic 留得住细节，代价可以忽略。
        f"scale={profile.width}:{profile.height}:force_original_aspect_ratio=decrease"
        f":flags=lanczos,"
        f"pad={profile.width}:{profile.height}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={profile.frame_rate},format=yuv420p,setsar=1[v{index}]"
    )


def _concat_keyframes(
    cuts: Sequence[MediaCut], keyframes: Mapping[Path, Sequence[float]], *, frame_rate: Fraction
) -> str:
    """拼接产物的关键帧时刻表，写成 ``-force_key_frames`` 收的逗号分隔串。

    每段在产物里从之前各段时长之和处起；关键帧是每段的起点，加上这段素材在 ``[start, end)``
    里原有的关键帧，换算到产物时间。换算后落到产物的第几帧（按 ``frame_rate`` 取最近的一帧），
    同一帧只留一个。

    交给 ffmpeg 的是每个关键帧往前半帧的时刻：ffmpeg 把第一个时间戳不早于给定时刻的帧编成
    关键帧，给帧的正点时刻会因为写成十进制时向上舍入而落到下一帧；同一帧给两个时刻，它会把
    后一帧也编成关键帧。"""

    frames: set[int] = set()
    offset = 0.0
    for cut in cuts:
        inside = [k for k in keyframes[cut.source] if cut.start <= k < cut.end]
        for time in [cut.start, *inside]:
            frames.add(round(Fraction(offset + time - cut.start) * frame_rate))
        offset += cut.duration
    return ",".join(
        f"{max(Fraction(0), (frame - Fraction(1, 2)) / frame_rate):.6f}" for frame in sorted(frames)
    )


@dataclass(frozen=True, slots=True)
class FilmCaption:
    """整片上的一句字幕：整片时间里的起止（秒）与烧进画面的文字。"""

    start: float
    end: float
    text: str


@dataclass(frozen=True, slots=True)
class FilmMusic:
    """整片的背景音乐：本地文件、从第几秒起用，以及整片时间上的音量曲线。"""

    source: Path
    offset: float
    gain: Sequence[tuple[float, float]]
    """``(整片时刻秒, 线性音量)``，按时刻严格递增，至少一个点；点间线性插值，两端取端点的值。"""


@dataclass(frozen=True, slots=True)
class FilmSound:
    """整片的声音怎么做：各段原声与音乐先各自统一到的响度、混好后整片的响度与峰值上限、每段原声
    两端的淡入淡出与音乐结尾的淡出（秒）。"""

    speech_lufs: float
    music_lufs: float
    loudness_lufs: float
    peak_dbfs: float
    edge_fade: float
    music_fade_out: float


class MusicTooShort(MediaError):
    """音乐从起点往后不够整片那么长。不循环补长，这条整片失败。"""


MAX_LOUDNESS_BOOST_DB: Final = 20.0
"""统一响度时最多放大多少 dB。很轻的声音（几乎只有底噪）照差值放大会把噪声抬得很响，到这里为止；
衰减不设限。"""

FILM_END_TOLERANCE: Final = 0.05
"""整片的段结尾最多比素材量出的时长多出几秒（50 毫秒，同受理时的容差）：调用方的时间来自浏览器，
与 ffprobe 量的隔着一次容器时长的取整。再多就是段与素材对不上，整片失败。"""

SUBTITLE_FONT: Final = "Noto Sans CJK SC"
"""烧字幕用的字体：镜像里 apt 装的 ``fonts-noto-cjk``（SIL OFL 1.1）里的简体中文无衬线体。"""
SUBTITLE_FONTS_DIR: Final = Path("/usr/share/fonts/opentype/noto")
"""那个字体包装到的目录，交给 libass 的 ``fontsdir``。"""
SUBTITLE_FONT_SIZE_RATIO: Final = 0.045
"""ASS 字号是画面高度的几分之几。libass 的字号是行高，思源黑体一个汉字约宽字号的 0.69：竖屏 1920 高
字号 86、一个字约 60 像素，一行放得下十五六个字；横屏 1080 高一个字约 34 像素。短视频以竖屏为主，
按竖屏取值，横屏的字相对小些。"""
SUBTITLE_OUTLINE_RATIO: Final = 0.08
"""描边粗细是字号的几分之几。"""
SUBTITLE_MARGIN_BOTTOM_RATIO: Final = 0.12
"""字幕底边离画面底边多远（画面高度的比例）：避开短视频平台压在画面底部的文案与按钮。"""
SUBTITLE_MARGIN_SIDE_RATIO: Final = 0.06
"""字幕离左右两边至少多远（画面宽度的比例），按它算一行放得下多宽。"""

_SAFE_FILTER_PATH: Final = re.compile(r"[A-Za-z0-9/._+-]+")
"""能原样写进滤镜参数的路径：滤镜图要对冒号、引号、反斜杠、逗号等转义两层，只收不用转义的字符。"""


async def render_film(
    cuts: Sequence[MediaCut],
    *,
    intro: Path | None,
    outro: Path | None,
    profile: VideoProfile,
    captions: Sequence[FilmCaption],
    music: FilmMusic | None,
    sound: FilmSound,
    dest: Path,
    codec: MediaCodec,
    workdir: Path,
    fonts_dir: Path = SUBTITLE_FONTS_DIR,
) -> None:
    """把各段按顺序首尾相接剪成一条整片写到 ``dest``，``intro`` 整条接在最前、``outro`` 整条接在
    最后：画面对齐到 ``profile``、烧进字幕，声音是原声与背景音乐的混音。中间文件（混好的声音、字幕
    文件）写在 ``workdir``。

    ``captions`` 与 ``music`` 的时刻从第一段开头算，只覆盖各段：这里按片头的长度往后挪，片头片尾上
    没有字幕、不铺音乐。

    画面：各段与片头片尾的裁剪、对齐与关键帧同 ``cut_concat``。字幕按统一样式写成 ASS，用 libass
    的 ``subtitles`` 滤镜烧进画面，字体从 ``fonts_dir`` 找；有字幕而本机 ffmpeg 没有这个滤镜就失败，
    不出没烧字幕的片。

    声音分三遍：先量每条来源整段的响度，各段与片头片尾的原声按差值统一到 ``sound.speech_lufs``、
    两端各淡入淡出 ``sound.edge_fade``，没有音轨的补静音，首尾相接；有音乐时量它整段的响度统一到
    ``sound.music_lufs``，从 ``music.offset`` 起取各段那么长，按音量曲线调、结尾淡出，对齐到第一段
    开头与原声相加（不取平均），写成一个中间文件；再量混音的响度；最后编码时按差值统一到
    ``sound.loudness_lufs`` 并限幅到 ``sound.peak_dbfs``。

    段的结尾超出素材的时长（容差 ``FILM_END_TOLERANCE``）、素材读不了、ffmpeg 失败抛 MediaError；
    音乐不够长抛 ``MusicTooShort``。"""

    if not cuts:
        raise MediaError("没有要剪的段")
    for cut in cuts:
        _check_cut(cut)
    brands = [brand for brand in (intro, outro) if brand is not None]
    for brand in brands:
        if not brand.is_file():
            raise MediaError(f"片头片尾的素材不在: {brand.name}")
    sources = list(dict.fromkeys([*brands, *(cut.source for cut in cuts)]))
    lengths = {source: await probe_duration_ms(source) / 1000 for source in sources}
    for position, cut in enumerate(cuts, start=1):
        if cut.end > lengths[cut.source] + FILM_END_TOLERANCE:
            raise MediaError(
                f"第 {position} 段的结尾 {cut.end:.3f} 秒超出了素材的时长 "
                f"{lengths[cut.source]:.3f} 秒"
            )
    # 片头片尾整条取用，长度按本地文件量，不按受理时记的时长：两者隔着一次容器时长的取整。
    head = [MediaCut(source=intro, start=0.0, end=lengths[intro])] if intro is not None else []
    tail = [MediaCut(source=outro, start=0.0, end=lengths[outro])] if outro is not None else []
    clips = [*head, *cuts, *tail]
    segments_start = head[0].duration if head else 0.0
    speech_gains: dict[Path, float | None] = {}
    for source in sources:
        audible = (await probe_video(source)).has_audio
        speech_gains[source] = (
            _gain_to(await integrated_loudness(source), sound.speech_lufs) if audible else None
        )
    segments_length = sum(cut.duration for cut in cuts)
    music_gain = 0.0
    if music is not None:
        if not await has_audio_stream(music.source):
            raise MediaError("音乐里没有音轨")
        music_length = await probe_duration_ms(music.source) / 1000
        if music.offset + segments_length > music_length + 0.001:
            raise MusicTooShort(
                f"音乐从 {music.offset:.3f} 秒起只剩 {max(0.0, music_length - music.offset):.3f} 秒，"
                f"不够整片的 {segments_length:.3f} 秒"
            )
        music_gain = _gain_to(await integrated_loudness(music.source), sound.music_lufs)

    mixed = workdir / "film-audio.wav"
    await _mix_film_audio(
        clips,
        speech_gains,
        music=music,
        music_gain=music_gain,
        music_start=segments_start,
        music_length=segments_length,
        sound=sound,
        dest=mixed,
    )
    film_gain = _gain_to(await integrated_loudness(mixed), sound.loudness_lufs)

    subtitles = None
    if captions:
        await _require_subtitles_filter()
        subtitles = workdir / "film-captions.ass"
        shifted = [
            FilmCaption(
                start=caption.start + segments_start,
                end=caption.end + segments_start,
                text=caption.text,
            )
            for caption in captions
        ]
        subtitles.write_text(
            ass_document(shifted, width=profile.width, height=profile.height), encoding="utf-8"
        )
    keyframes = _concat_keyframes(
        clips,
        {source: await probe_keyframes(source) for source in sources},
        frame_rate=Fraction(profile.frame_rate),
    )
    inputs: list[str] = []
    chains: list[str] = []
    for index, clip in enumerate(clips):
        inputs += [*codec.decode, "-i", str(clip.source)]
        chains.append(_video_chain(index, clip, profile))
    inputs += ["-i", str(mixed)]
    burn = (
        "null"
        if subtitles is None
        else f"subtitles=filename={_filter_path(subtitles)}:fontsdir={_filter_path(fonts_dir)},"
        "format=yuv420p"
    )
    chains.append(
        f"{''.join(f'[v{index}]' for index in range(len(clips)))}"
        f"concat=n={len(clips)}:v=1:a=0,{burn}[outv]"
    )
    chains.append(
        f"[{len(clips)}:a]volume={film_gain:.2f}dB,"
        # level=0：不让限幅器自动把输出拉满；latency=1：抵掉它向前看的那几毫秒延迟。
        f"alimiter=limit={10 ** (sound.peak_dbfs / 20):.4f}:level=0:latency=1[outa]"
    )
    args = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chains)]
    args += ["-map", "[outv]", "-map", "[outa]", *_AUDIO_CODEC]
    args += ["-ar", str(_AUDIO_RATE), "-ac", "2"]
    args += [*codec.encode, "-force_key_frames", keyframes]
    args += ["-movflags", "+faststart", str(dest)]
    await run(args, timeout=ENCODE_TIMEOUT_SECONDS)
    _check_output(dest, max_bytes=MAX_VIDEO_BYTES)


async def _mix_film_audio(
    clips: Sequence[MediaCut],
    speech_gains: Mapping[Path, float | None],
    *,
    music: FilmMusic | None,
    music_gain: float,
    music_start: float,
    music_length: float,
    sound: FilmSound,
    dest: Path,
) -> None:
    """各段（含片头片尾）原声首尾相接、混上音乐，写成 48 kHz 双声道 32 位浮点 wav：混音可能超过
    满幅，浮点留着给最后一遍限幅，不在这里削波。``speech_gains`` 是每条来源的增益（dB），没有音轨
    为 None。音乐只取 ``music_length`` 秒，从整片的 ``music_start`` 秒处起铺（片头之后）。

    每段一路输入，同一条来源取几段就开几次：滤镜图里一路输入只能接一次。"""

    stereo = f"aformat=sample_rates={_AUDIO_RATE}:channel_layouts={_AUDIO_LAYOUT}"
    inputs: list[str] = []
    chains: list[str] = []
    for index, clip in enumerate(clips):
        length = clip.duration
        gain = speech_gains[clip.source]
        if gain is None:
            chains.append(
                f"anullsrc=channel_layout={_AUDIO_LAYOUT}:sample_rate={_AUDIO_RATE},"
                f"atrim=duration={length:.3f}[s{index}]"
            )
            continue
        inputs += ["-i", str(clip.source)]
        fade = min(sound.edge_fade, length / 2)
        chain = (
            f"[{len(inputs) // 2 - 1}:a]atrim=start={clip.start:.3f}:end={clip.end:.3f},"
            # 音轨比画面短时补静音，每段的声音正好是这段的长度，后面各段才对得上画面。
            f"asetpts=PTS-STARTPTS,{stereo},apad=whole_dur={length:.3f},"
            f"atrim=duration={length:.3f},volume={gain:.2f}dB"
        )
        if fade > 0:
            chain += f",afade=t=in:d={fade:.3f},afade=t=out:st={length - fade:.3f}:d={fade:.3f}"
        chains.append(f"{chain}[s{index}]")
    chains.append(
        f"{''.join(f'[s{index}]' for index in range(len(clips)))}"
        f"concat=n={len(clips)}:v=0:a=1[speech]"
    )
    output = "[speech]"
    if music is not None:
        fade = min(sound.music_fade_out, music_length)
        inputs += ["-i", str(music.source)]
        # 曲线与淡出都在音乐自己的时间上算（从第一段开头起），算完再整体往后挪过片头。
        delay = round(music_start * 1000)
        shift = f",adelay=delays={delay}|{delay}" if delay > 0 else ""
        chains.append(
            f"[{len(inputs) // 2 - 1}:a]atrim=start={music.offset:.3f}:duration={music_length:.3f},"
            f"asetpts=PTS-STARTPTS,{stereo},volume={music_gain:.2f}dB,"
            # 曲线按帧求值：帧切成 10 毫秒一帧，音量的台阶小到听不出。
            f"asetnsamples=n={_AUDIO_RATE // 100}:p=0,"
            f"volume='{_gain_curve(music.gain)}':eval=frame,"
            f"afade=t=out:st={music_length - fade:.3f}:d={fade:.3f}{shift}[music]"
        )
        # duration=first：混音跟原声一样长，音乐在片尾之前就完了，片尾那一段只剩原声。
        chains.append("[speech][music]amix=inputs=2:duration=first:normalize=0[mix]")
        output = "[mix]"
    await run(
        [
            "ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chains),
            "-map", output, "-c:a", "pcm_f32le", "-ar", str(_AUDIO_RATE), "-ac", "2", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    _check_output(dest, max_bytes=MAX_VIDEO_BYTES)


def _gain_to(measured: float, target: float) -> float:
    """把响度 ``measured`` 调到 ``target`` 要的增益（dB）。静音（``-inf``）不调；放大最多
    ``MAX_LOUDNESS_BOOST_DB``。"""

    if not math.isfinite(measured):
        return 0.0
    return min(target - measured, MAX_LOUDNESS_BOOST_DB)


def _gain_curve(points: Sequence[tuple[float, float]]) -> str:
    """音量曲线写成 ffmpeg 表达式（变量 ``t`` 是整片时刻秒）：第一个点的值，加上每一段的增量乘以
    这一段走过的比例（夹在 0 到 1）。各段平铺相加、不嵌套，几百个点也不会让解析器递归过深。"""

    (_, first), *_ = points
    terms = [f"{first:.6g}"]
    for (start, before), (end, after) in itertools.pairwise(points):
        terms.append(f"({after - before:.6g})*clip((t-{start:.6g})/{end - start:.6g},0,1)")
    return "+".join(terms)


async def _require_subtitles_filter() -> None:
    """本机 ffmpeg 有 libass 的 ``subtitles`` 滤镜；没有抛 MediaError（不出没烧字幕的片）。"""

    listing = await run(["ffmpeg", "-hide_banner", "-filters"], timeout=PROBE_TIMEOUT_SECONDS)
    if not any(line.split()[1:2] == ["subtitles"] for line in listing.decode().splitlines()):
        raise MediaError("本机的 ffmpeg 没有 subtitles 滤镜（libass），烧不了字幕")


def _filter_path(path: Path) -> str:
    """路径原样写进滤镜参数；有要转义的字符就拒绝，不去猜转义。"""

    text = str(path)
    if not _SAFE_FILTER_PATH.fullmatch(text):
        raise MediaError(f"路径里有滤镜参数要转义的字符: {text}")
    return text


def ass_document(captions: Sequence[FilmCaption], *, width: int, height: int) -> str:
    """按统一样式把字幕写成一份 ASS：白字、深色描边、底部居中，字号随画面高度。

    画布就是画面大小（``PlayResX/Y``），样式里的像素与画面一一对应。中文没有空格可断行，不靠
    libass 自己折：按字宽估算，一句放不下就在这里均匀折成几行（``WrapStyle: 2`` 让 libass 只认
    这些换行）。ASS 会把 ``{…}`` 当样式指令、把反斜杠当转义，文字里的这三个字符换成全角的同形字。"""

    font_size = max(1, round(height * SUBTITLE_FONT_SIZE_RATIO))
    outline = max(1, round(font_size * SUBTITLE_OUTLINE_RATIO))
    margin_side = round(width * SUBTITLE_MARGIN_SIDE_RATIO)
    margin_bottom = round(height * SUBTITLE_MARGIN_BOTTOM_RATIO)
    line_width = max(font_size, width - 2 * margin_side)
    header = "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,"
            " BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,"
            " BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            # 颜色是 &HAABBGGRR：白字、黑色描边；Bold -1 用粗体，Alignment 2 是底部居中。
            f"Style: Default,{SUBTITLE_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,"
            f"&H00000000,-1,0,0,0,100,100,0,0,1,{outline},0,2,{margin_side},{margin_side},"
            f"{margin_bottom},1",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
    )
    events = [
        f"Dialogue: 0,{_ass_time(caption.start)},{_ass_time(caption.end)},Default,,0,0,0,,"
        f"{_ass_text(caption.text, font_size=font_size, line_width=line_width)}"
        for caption in captions
    ]
    return "\n".join([header, *events, ""])


def _ass_time(seconds: float) -> str:
    """ASS 的时刻写法 ``H:MM:SS.cc``（百分之一秒）。"""

    centis = round(seconds * 100)
    hours, rest = divmod(centis, 360_000)
    minutes, rest = divmod(rest, 6_000)
    whole, centi = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{whole:02d}.{centi:02d}"


def _ass_text(text: str, *, font_size: int, line_width: int) -> str:
    """一句字幕的 ASS 文字：转掉 ASS 的特殊字符，按估算的字宽折行，行之间用 ``\\N``。"""

    safe = text.replace("\\", "＼").replace("{", "｛").replace("}", "｝")
    lines: list[str] = []
    for paragraph in safe.splitlines():
        lines += _wrap(paragraph.strip(), font_size=font_size, line_width=line_width)
    return "\\N".join(line for line in lines if line)


_WIDE_GLYPH: Final = 0.7
_NARROW_GLYPH: Final = 0.45
"""估算字宽用的系数（相对 ASS 的字号）。libass 让字体的行高等于字号，思源黑体（Noto Sans CJK）一个
全角字的宽约是字号的 0.69；半角字母数字平均更窄，按 0.45 估，宁宽勿窄。"""


def _wrap(paragraph: str, *, font_size: int, line_width: int) -> list[str]:
    """把一段折成宽度相近的几行，每行不超过 ``line_width``。

    先按估算的总宽定行数（每行留出一个字的余量），再按每个字的中点落在第几等分里分到那一行，
    所以行数正好是算出来的那几行，各行一样宽，不会剩下孤零零的一个字。"""

    widths = [
        font_size
        * (_WIDE_GLYPH if unicodedata.east_asian_width(char) in ("W", "F") else _NARROW_GLYPH)
        for char in paragraph
    ]
    total = sum(widths)
    if total <= line_width:
        return [paragraph]
    count = math.ceil(total / max(1.0, line_width - max(widths)))
    share = total / count
    lines = [""] * count
    used = 0.0
    for char, width in zip(paragraph, widths, strict=True):
        lines[min(count - 1, int((used + width / 2) / share))] += char
        used += width
    return [line.strip() for line in lines]


def _check_cut(cut: MediaCut) -> None:
    if not cut.source.is_file():
        raise MediaError(f"要裁的素材不在: {cut.source.name}")
    if cut.start < 0 or cut.duration <= 0:
        raise MediaError(f"片段区间无效: [{cut.start}, {cut.end})")


def _safe_url(url: str) -> str:
    """去掉查询串的地址：签名参数不进日志，也不进对外错误。"""

    return url.split("?", 1)[0]


def _check_output(dest: Path, *, max_bytes: int) -> None:
    """产物必须存在、非空，且不超过读进内存的上限。"""

    size = dest.stat().st_size if dest.is_file() else 0
    if size == 0:
        raise MediaError(f"ffmpeg 没产出内容: {dest.name}")
    if size > max_bytes:
        raise MediaError(f"产物 {size} 字节，超过 {max_bytes} 字节的上限: {dest.name}")


async def run(args: list[str], *, timeout: float) -> bytes:
    """执行子进程并返回 stdout；超时先 kill 再 wait。"""

    stdout, _ = await _communicate(args, timeout=timeout)
    return stdout


async def _communicate(args: list[str], *, timeout: float) -> tuple[bytes, bytes]:
    """执行子进程并返回 (stdout, stderr)；退出码非 0 抛 MediaError，超时先 kill 再 wait。

    ffmpeg 有的滤镜只把测量结果写到 stderr（如 ``loudnorm`` 的 JSON），要读它的走这里。"""

    # 禁止读取终端输入，避免后台进程组收到 SIGTTIN 后连同后端一起暂停。
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        # 部署缺二进制不能让裸 FileNotFoundError 逃出队列，调用方只认 MediaError。
        raise MediaError(f"PATH 上找不到 {args[0]}") from None
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise MediaError(f"{args[0]} 超过 {timeout:.0f} 秒还没结束") from None
    except asyncio.CancelledError:
        # 任务被取消（队列关停）时不能把 ffmpeg 留成孤儿：一次重编码能占满 CPU 十几分钟。
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        detail = stderr.decode(errors="replace")[:_STDERR_LIMIT]
        raise MediaError(f"{args[0]} 失败（退出码 {process.returncode}）: {detail}")
    return stdout, stderr


__all__ = [
    "DOWNLOAD_TIMEOUT_SECONDS",
    "ENCODE_TIMEOUT_SECONDS",
    "FILM_END_TOLERANCE",
    "MAX_AUDIO_BYTES",
    "MAX_IMAGE_BYTES",
    "MAX_LOUDNESS_BOOST_DB",
    "MAX_VIDEO_BYTES",
    "MUSIC_LOUDNESS_LUFS",
    "MUSIC_LOUDNESS_RANGE",
    "MUSIC_SILENCE_THRESHOLD_DB",
    "MUSIC_TRUE_PEAK_DBTP",
    "PROBE_TIMEOUT_SECONDS",
    "REMOTE_READ_TIMEOUT_SECONDS",
    "SPEECH_BITRATE",
    "SPEECH_SAMPLE_RATE",
    "SUBTITLE_FONT",
    "SUBTITLE_FONTS_DIR",
    "SUBTITLE_FONT_SIZE_RATIO",
    "SUBTITLE_MARGIN_BOTTOM_RATIO",
    "SUBTITLE_MARGIN_SIDE_RATIO",
    "SUBTITLE_OUTLINE_RATIO",
    "FilmCaption",
    "FilmMusic",
    "FilmSound",
    "MediaCut",
    "MediaError",
    "MusicTooShort",
    "NoAudioStream",
    "VideoProfile",
    "ass_document",
    "cut_concat",
    "download",
    "extract_speech_audio",
    "fetched",
    "ffmpeg_available",
    "has_audio_stream",
    "integrated_loudness",
    "normalize_music",
    "probe_duration_ms",
    "probe_keyframes",
    "probe_remote_duration_ms",
    "probe_video",
    "render_film",
    "run",
]
