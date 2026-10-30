from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any

from agent_runtime.errors import ValidationFailed

from iclip.domains.generation.schemas import (
    MAX_PROMPT_CHARS,
    ClipEditDurationOut,
    ClipImageDurationOut,
    VideoClipModelOut,
)


@dataclass(frozen=True, slots=True)
class UpstreamMode:
    prompt_prefix: str = ""
    provider_options: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))

    def prompt(self, prompt: str) -> str:
        if not self.prompt_prefix:
            return prompt
        prefixed = prompt if prompt.startswith(self.prompt_prefix) else self.prompt_prefix + prompt
        if len(prefixed) > MAX_PROMPT_CHARS:
            raise ValidationFailed(
                f"编辑修改要求最多 {MAX_PROMPT_CHARS - len(self.prompt_prefix)} 字，请缩短后重试"
            )
        return prefixed

    def options(self, given: dict[str, Any] | None) -> dict[str, Any] | None:
        if not self.provider_options:
            return given
        for key, expected in self.provider_options.items():
            if given is not None and key in given and given[key] != expected:
                raise ValidationFailed(f"当前模式的 {key} 必须为 {expected}")
        return {**(given or {}), **self.provider_options}


@dataclass(frozen=True, slots=True)
class ClipModel:
    spec: VideoClipModelOut
    edit_mode: UpstreamMode = UpstreamMode()
    """视频编辑时补的上游语义；图生沿用网关按图片张数的原生调度，不补。"""


_MODELS = (
    ClipModel(
        VideoClipModelOut(
            id="seedance-2-0",
            max_reference_images=9,
            image=ClipImageDurationOut(min_seconds=4, max_seconds=15, default_seconds=5),
            edit=None,
        ),
    ),
    ClipModel(
        VideoClipModelOut(
            id="seedance-2-5",
            max_reference_images=30,
            image=ClipImageDurationOut(min_seconds=4, max_seconds=30, default_seconds=5),
            edit=ClipEditDurationOut(min_seconds=4, max_seconds=30),
        ),
        # Seedance 2.5 只有显式指定原生子任务才按视频编辑执行。
        edit_mode=UpstreamMode(provider_options={"omni_reference_task_type": "edit"}),
    ),
    ClipModel(
        VideoClipModelOut(
            id="wan3",
            max_reference_images=10,
            image=ClipImageDurationOut(min_seconds=2, max_seconds=30, default_seconds=5),
            edit=ClipEditDurationOut(min_seconds=1, max_seconds=15),
        ),
        # Wan 靠正文开头的「编辑视频，」认出视频编辑任务。
        edit_mode=UpstreamMode(prompt_prefix="编辑视频，"),
    ),
)


def clip_model(model: str) -> ClipModel | None:
    for clip in _MODELS:
        if clip.spec.id in model.lower():
            return replace(clip, spec=clip.spec.model_copy(update={"id": model}))
    return None


__all__ = ["ClipModel", "UpstreamMode", "clip_model"]
