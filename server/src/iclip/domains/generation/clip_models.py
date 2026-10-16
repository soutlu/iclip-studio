"""片段生成入口的模型能力；列表展示与新请求受理共用，历史记录不套用。"""

from iclip.domains.generation.schemas import (
    ClipEditDurationOut,
    ClipImageDurationOut,
    VideoClipModelOut,
)

_MODELS = (
    VideoClipModelOut(
        id="seedance-2-0",
        max_reference_images=9,
        image=ClipImageDurationOut(min_seconds=4, max_seconds=15, default_seconds=5),
        edit=None,
    ),
    VideoClipModelOut(
        id="seedance-2-5",
        max_reference_images=30,
        image=ClipImageDurationOut(min_seconds=4, max_seconds=30, default_seconds=5),
        edit=ClipEditDurationOut(min_seconds=4, max_seconds=30),
    ),
    VideoClipModelOut(
        id="wan3",
        max_reference_images=10,
        image=ClipImageDurationOut(min_seconds=2, max_seconds=30, default_seconds=5),
        edit=ClipEditDurationOut(min_seconds=1, max_seconds=15),
    ),
)


def clip_model(model: str) -> VideoClipModelOut | None:
    """识别已接入的模型系列，保留配置中的供应商前缀与模型 id。"""

    for spec in _MODELS:
        if spec.id in model.lower():
            return spec.model_copy(update={"id": model})
    return None
