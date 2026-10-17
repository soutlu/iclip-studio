from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from iclip.platform.media.audio import AUDIO_CODEC, AUDIO_LAYOUT, AUDIO_RATE
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_VIDEO_BYTES
from iclip.platform.media.probe import VideoProfile, probe_keyframes, probe_video
from iclip.platform.media.process import ENCODE_TIMEOUT_SECONDS, check_output, run


@dataclass(frozen=True, slots=True)
class MediaCut:
    source: Path
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def check_cut(cut: MediaCut) -> None:
    if not cut.source.is_file():
        raise MediaError(f"要裁的素材不在: {cut.source.name}")
    if cut.start < 0 or cut.duration <= 0:
        raise MediaError(f"片段区间无效: [{cut.start}, {cut.end})")


async def cut_concat(
    cuts: Sequence[MediaCut], *, profile: VideoProfile, dest: Path, codec: MediaCodec
) -> None:
    if not cuts:
        raise MediaError("没有要拼的片段")
    for cut in cuts:
        check_cut(cut)
    silent = [not (await probe_video(cut.source)).has_audio for cut in cuts]
    keyframes = await _keyframe_plan(cuts, profile=profile)

    # 各段参数互不相同，走 concat 滤镜：concat 分离器要求各输入参数一致。
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
                source = f"[{len(cuts) + silent[:index].count(True)}:a]"
                inputs += [
                    "-f",
                    "lavfi",
                    "-t",
                    f"{cut.duration:.3f}",
                    "-i",
                    f"anullsrc=channel_layout={AUDIO_LAYOUT}:sample_rate={AUDIO_RATE}",
                ]
                chains.append(f"{source}asetpts=PTS-STARTPTS[a{index}]")
            else:
                chains.append(
                    f"[{index}:a]atrim=start={cut.start:.3f}:end={cut.end:.3f},"
                    f"asetpts=PTS-STARTPTS,"
                    f"aformat=sample_rates={AUDIO_RATE}:channel_layouts={AUDIO_LAYOUT}[a{index}]"
                )
            labels.insert(2 * index + 1, f"[a{index}]")

    chains.append(
        f"{''.join(labels)}concat=n={len(cuts)}:v=1:a={1 if profile.has_audio else 0}"
        f"[outv]{'[outa]' if profile.has_audio else ''}"
    )
    args = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chains)]
    args += ["-map", "[outv]"]
    if profile.has_audio:
        args += ["-map", "[outa]", *AUDIO_CODEC]
    args += [*codec.encode, "-force_key_frames", keyframes]
    args += ["-movflags", "+faststart", str(dest)]
    await run(args, timeout=ENCODE_TIMEOUT_SECONDS)
    check_output(dest, max_bytes=MAX_VIDEO_BYTES)


def _video_chain(index: int, cut: MediaCut, profile: VideoProfile) -> str:
    return (
        f"[{index}:v]trim=start={cut.start:.3f}:end={cut.end:.3f},setpts=PTS-STARTPTS,"
        f"scale={profile.width}:{profile.height}:force_original_aspect_ratio=decrease"
        f":flags=lanczos,"
        f"pad={profile.width}:{profile.height}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={profile.frame_rate},format=yuv420p,setsar=1[v{index}]"
    )


async def _keyframe_plan(cuts: Sequence[MediaCut], *, profile: VideoProfile) -> str:
    sources = dict.fromkeys(cut.source for cut in cuts)
    return _concat_keyframes(
        cuts,
        {source: await probe_keyframes(source) for source in sources},
        frame_rate=Fraction(profile.frame_rate),
    )


def _concat_keyframes(
    cuts: Sequence[MediaCut], keyframes: Mapping[Path, Sequence[float]], *, frame_rate: Fraction
) -> str:
    frames: set[int] = set()
    offset = 0.0
    for cut in cuts:
        inside = [k for k in keyframes[cut.source] if cut.start <= k < cut.end]
        for time in [cut.start, *inside]:
            frames.add(round(Fraction(offset + time - cut.start) * frame_rate))
        offset += cut.duration
    # ffmpeg 把第一个时间戳不早于给定时刻的帧编成关键帧。给帧的正点时刻会因十进制写法向上舍入而
    # 落到下一帧，所以往前挪半帧；同一帧给两个时刻，它会把后一帧也编成关键帧，所以先按帧去重。
    return ",".join(
        f"{max(Fraction(0), (frame - Fraction(1, 2)) / frame_rate):.6f}" for frame in sorted(frames)
    )


__all__ = [
    "MediaCut",
    "check_cut",
    "cut_concat",
]
